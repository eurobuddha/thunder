/**
 * ============================================================================
 * TNZEC — Thunder Network Zero Edge Casino
 * Routing Engine
 * ============================================================================
 *
 * Lightning-style game routing for the Casino hub.
 *
 * The Casino hub maintains 2-party ELTOO channels with each player.
 * When a player requests a game, the hub routes it to an online house
 * player. Commit-reveal secrets flow through the hub like Lightning
 * HTLCs — the hub NEVER generates game secrets, only forwards them.
 *
 * Hub net exposure = 0. What it loses in the player's channel, it gains
 * in the house's channel. Same secrets, same outcome, opposite sides.
 *
 * HOUSE SELECTION (Phase 1 — single house, best fit):
 *   1. Game request arrives with bet amount and game type
 *   2. Calculate required house capacity: bet × (range - 1)
 *   3. Find online players whose channel balance covers that capacity
 *   4. Select the best fit (largest available balance)
 *   5. If nobody qualifies → hub operator is the house (fallback)
 *
 * ============================================================================
 */


/* =========================================================================
 * HUB MODE DETECTION
 * ========================================================================= */

/**
 * Hub mode flag — set during init based on config.
 * When true, GAME_REQUEST triggers routing instead of direct house play.
 * When false (spoke mode), everything works as the current 2-party game.
 */
var TNZEC_HUB_MODE = false;

/**
 * Check if this node is running as a hub (Casino routing node).
 */
function isHubMode(){
	return TNZEC_HUB_MODE;
}

/**
 * Enable hub mode. Called during service.js init if config says "hub".
 */
function enableHubMode(){
	TNZEC_HUB_MODE = true;
	MDS.log("[TNZEC] Hub mode ENABLED — routing games to online houses");
}

/**
 * Disable hub mode (spoke mode — normal player).
 */
function disableHubMode(){
	TNZEC_HUB_MODE = false;
	MDS.log("[TNZEC] Spoke mode — standard player");
}


/* =========================================================================
 * ROUTING STATE
 * =========================================================================
 * Tracks which player channel is linked to which house channel for
 * each active routed game. Stored in SQL (routed_games table) and
 * cached in memory for fast lookups during message forwarding.
 * ========================================================================= */

/** In-memory routing cache: player_hashid → {house_hashid, house_maximaid, status} */
var ACTIVE_ROUTES = {};

/** Reverse lookup: house_hashid → player_hashid */
var REVERSE_ROUTES = {};

/**
 * Register a new route: player channel → house channel.
 * Stored in both SQL and memory cache.
 */
function addRoute(playerHashid, houseHashid, playerMaximaid, houseMaximaid, gametype, betamt, callback){

	ACTIVE_ROUTES[playerHashid] = {
		house_hashid:   houseHashid,
		house_maximaid: houseMaximaid,
		player_maximaid: playerMaximaid,
		gametype:       gametype,
		betamt:         betamt
	};
	REVERSE_ROUTES[houseHashid] = playerHashid;

	MDS.sql("INSERT INTO routed_games (player_hashid, house_hashid, player_maximaid, house_maximaid, "
		+"gametype, betamount, status, date) VALUES ('"
		+playerHashid+"','"+houseHashid+"','"+playerMaximaid+"','"+houseMaximaid
		+"','"+gametype+"','"+betamt+"','active',"+getTimeMilli()+")",
		function(res){
			MDS.log("[TNZEC] Route added: player="+playerHashid.substring(0,12)
				+".. → house="+houseHashid.substring(0,12)+"..");
			if(callback){ callback(res); }
		});
}

/**
 * Look up route by player's channel hashid.
 * Returns {house_hashid, house_maximaid, ...} or null.
 */
function getRouteByPlayer(playerHashid){
	return ACTIVE_ROUTES[playerHashid] || null;
}

/**
 * Look up route by house's channel hashid.
 * Returns the player's channel hashid or null.
 */
function getPlayerByHouse(houseHashid){
	return REVERSE_ROUTES[houseHashid] || null;
}

/**
 * Check if a game in this channel is being routed.
 */
function isRoutedGame(hashid){
	return (ACTIVE_ROUTES[hashid] != null) || (REVERSE_ROUTES[hashid] != null);
}

/**
 * Clear a completed route.
 */
function clearRoute(playerHashid, callback){
	var route = ACTIVE_ROUTES[playerHashid];
	if(route){
		delete REVERSE_ROUTES[route.house_hashid];
	}
	delete ACTIVE_ROUTES[playerHashid];

	MDS.sql("UPDATE routed_games SET status='completed' WHERE player_hashid='"+playerHashid
		+"' AND status='active'", function(res){
			MDS.log("[TNZEC] Route cleared: player="+playerHashid.substring(0,12)+"..");
			if(callback){ callback(res); }
		});
}

/**
 * Reload active routes from SQL into memory cache.
 * Called during service.js init to survive restarts.
 */
function loadActiveRoutes(callback){
	MDS.sql("SELECT * FROM routed_games WHERE status='active'", function(res){
		if(res.status && res.count > 0){
			for(var i=0; i<res.count; i++){
				var row = res.rows[i];
				ACTIVE_ROUTES[row.PLAYER_HASHID] = {
					house_hashid:    row.HOUSE_HASHID,
					house_maximaid:  row.HOUSE_MAXIMAID,
					player_maximaid: row.PLAYER_MAXIMAID,
					gametype:        row.GAMETYPE,
					betamt:          row.BETAMOUNT
				};
				REVERSE_ROUTES[row.HOUSE_HASHID] = row.PLAYER_HASHID;
			}
			MDS.log("[TNZEC] Loaded "+res.count+" active routes from DB");
		}
		if(callback){ callback(); }
	});
}


/* =========================================================================
 * HOUSE SELECTION
 * =========================================================================
 * Select the best online house for a given game. Phase 1 uses single
 * house, best fit: the largest channel that can cover the required
 * house capacity.
 *
 * Required capacity = betamt × (range - 1)
 *   Flip:     bet × 1  (2x payout, house covers 1× bet)
 *   Dice:     bet × 5  (6x payout, house covers 5× bet)
 *   Roulette: bet × 35 (36x payout, house covers 35× bet)
 * ========================================================================= */

/**
 * Select the best available house for a game.
 *
 * Queries all open channels (excluding the requesting player's channel),
 * filters by online status and sufficient balance, picks the best fit.
 *
 * @param playerHashid   — The requesting player's channel (excluded)
 * @param betamt         — How much the player wants to bet
 * @param range          — Game range (2, 6, or 36)
 * @param callback       — Returns {hashid, maximaid, balance} or null if none available
 */
function selectHouse(playerHashid, betamt, range, callback){

	var requiredCapacity = new Decimal(betamt).mul(new Decimal(range - 1));

	// Query all open channels that aren't the player's and aren't currently in a game
	MDS.sql("SELECT * FROM channels WHERE state='STATE_CHANNEL_OPEN_1' AND hashid != '"
		+playerHashid+"' AND gamephase=0", function(res){

		if(!res.status || res.count == 0){
			MDS.log("[TNZEC] No available houses — zero open channels (excluding player)");
			if(callback){ callback(null); }
			return;
		}

		var bestHouse = null;
		var bestBalance = new Decimal(0);

		for(var i=0; i<res.count; i++){
			var row = res.rows[i];

			// The hub's counterparty in this channel is the potential house
			// The house's balance = the OTHER user's amount (from hub's perspective,
			// the hub is one user, the house candidate is the other)
			var houseBalance;
			var houseMaximaid;
			if(parseInt(row.USERNUM) == 1){
				// Hub is user1, house candidate is user2
				houseBalance = new Decimal(row.USER2AMOUNT);
				houseMaximaid = row.USER2MAXIMAID;
			}else{
				// Hub is user2, house candidate is user1
				houseBalance = new Decimal(row.USER1AMOUNT);
				houseMaximaid = row.USER1MAXIMAID;
			}

			// Skip if already routing a game through this channel
			if(REVERSE_ROUTES[row.HASHID]){ continue; }

			// Check if house has enough capacity
			// The hub side of the channel must cover potential loss
			var hubBalance;
			if(parseInt(row.USERNUM) == 1){
				hubBalance = new Decimal(row.USER1AMOUNT);
			}else{
				hubBalance = new Decimal(row.USER2AMOUNT);
			}

			// Hub needs enough on its side to cover the bet (hub is bettor in house channel)
			// House needs enough on its side to cover max payout
			if(hubBalance.lessThan(new Decimal(betamt))){
				continue; // Hub can't cover bet in this channel
			}
			if(houseBalance.lessThan(requiredCapacity)){
				continue; // House can't cover max payout
			}

			// Best fit: largest house balance (can handle biggest bets)
			if(houseBalance.greaterThan(bestBalance)){
				bestBalance = houseBalance;
				bestHouse = {
					hashid:    row.HASHID,
					maximaid:  houseMaximaid,
					balance:   houseBalance.toString()
				};
			}
		}

		if(bestHouse){
			MDS.log("[TNZEC] Selected house: "+bestHouse.hashid.substring(0,12)
				+".. balance:"+bestHouse.balance);
		}else{
			MDS.log("[TNZEC] No house with sufficient capacity. Required:"+requiredCapacity.toString());
		}

		if(callback){ callback(bestHouse); }
	});
}


/* =========================================================================
 * NETWORK CAPACITY
 * =========================================================================
 * Aggregate statistics for UI display.
 * ========================================================================= */

/**
 * Calculate network capacity — total available house balance across
 * all open channels (excluding a specific player if given).
 *
 * Returns: {
 *   online:    number of open channels,
 *   total:     total available house balance,
 *   maxFlip:   max coin flip bet,
 *   maxDice:   max dice bet,
 *   maxRoulette: max roulette bet
 * }
 */
function getNetworkCapacity(excludeHashid, callback){

	var where = "state='STATE_CHANNEL_OPEN_1' AND gamephase=0";
	if(excludeHashid){
		where += " AND hashid != '"+excludeHashid+"'";
	}

	MDS.sql("SELECT * FROM channels WHERE "+where, function(res){

		var capacity = {
			online:       0,
			total:        new Decimal(0),
			maxFlip:      "0",
			maxDice:      "0",
			maxRoulette:  "0",
			largestHouse: "0"
		};

		if(!res.status || res.count == 0){
			if(callback){ callback(capacity); }
			return;
		}

		var largest = new Decimal(0);

		for(var i=0; i<res.count; i++){
			var row = res.rows[i];

			// Skip channels already routing a game
			if(REVERSE_ROUTES[row.HASHID]){ continue; }

			// House balance = counterparty's amount
			var houseBalance;
			if(parseInt(row.USERNUM) == 1){
				houseBalance = new Decimal(row.USER2AMOUNT);
			}else{
				houseBalance = new Decimal(row.USER1AMOUNT);
			}

			if(houseBalance.greaterThan(DECIMAL_ZERO)){
				capacity.online++;
				capacity.total = capacity.total.plus(houseBalance);
				if(houseBalance.greaterThan(largest)){
					largest = houseBalance;
				}
			}
		}

		// Max bets are limited by the SINGLE largest house (Phase 1 — single house routing)
		// Flip: need 1× cover → max bet = largest house balance
		// Dice: need 5× cover → max bet = largest / 5
		// Roulette: need 35× cover → max bet = largest / 35
		capacity.largestHouse = largest.toString();
		capacity.maxFlip     = largest.toString();
		capacity.maxDice     = largest.div(new Decimal(5)).toString();
		capacity.maxRoulette = largest.div(new Decimal(35)).toString();
		capacity.total       = capacity.total.toString();

		if(callback){ callback(capacity); }
	});
}


/**
 * Get list of all network members (open channels) for UI display.
 */
function getNetworkMembers(callback){
	MDS.sql("SELECT hashid, user1name, user2name, user1amount, user2amount, usernum, "
		+"user1maximaid, user2maximaid, gamephase FROM channels "
		+"WHERE state='STATE_CHANNEL_OPEN_1'", function(res){

		var members = [];
		if(res.status && res.count > 0){
			for(var i=0; i<res.count; i++){
				var row = res.rows[i];
				var isUser1 = (parseInt(row.USERNUM) == 1);
				members.push({
					hashid:   row.HASHID,
					name:     isUser1 ? row.USER2NAME : row.USER1NAME,
					maximaid: isUser1 ? row.USER2MAXIMAID : row.USER1MAXIMAID,
					balance:  isUser1 ? row.USER2AMOUNT : row.USER1AMOUNT,
					inGame:   parseInt(row.GAMEPHASE) != 0,
					isRouting: REVERSE_ROUTES[row.HASHID] != null
				});
			}
		}
		if(callback){ callback(members); }
	});
}
