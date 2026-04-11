/**
 * ============================================================================
 * THUNDER CASINO — Commit-Reveal Game Logic
 * ============================================================================
 *
 * This file handles the cryptographic game protocol that runs OFF-CHAIN
 * via Maxima messages. It implements the commit-reveal pattern for
 * provably fair randomness:
 *
 *   1. Both parties generate a random secret
 *   2. Both commit SHA3(secret) — the hash, not the secret itself
 *   3. House reveals their secret to the player
 *   4. Player computes the outcome (they know both secrets now)
 *   5. Both sign the updated balance
 *
 * RANDOMNESS DERIVATION:
 *   combined_hash = SHA3(CONCAT(house_secret, player_secret))
 *   result = NUMBER(SUBSET(0, 4, combined_hash)) % range
 *
 *   - Coin flip: range=2, result is 0 or 1 (heads/tails)
 *   - Dice:      range=6, result is 0-5 (displayed as 1-6)
 *   - Roulette:  range=36, result is 0-35 (displayed as 1-36)
 *
 * WHY THIS IS FAIR:
 *   - Neither party can predict the outcome before both secrets are known
 *   - The house commits before seeing the player's commit
 *   - The player commits before seeing the house's secret
 *   - SHA3 is a one-way function — you can't reverse a commit to find the secret
 *   - CONCAT of both secrets means neither controls the randomness alone
 *   - The SAME math runs on-chain in the MAST dispute branch for verification
 *
 * SECRETS STORAGE:
 *   Secrets are stored in MDS.keypair keyed by their commit hash, NOT by coinid.
 *   Coinids change on phase transitions. Commit hashes are permanent.
 *   (Lesson learned: lost 6M in locked coins when secrets were lost after
 *   MiniDapp update because they were keyed by coinid — Wager incident)
 *
 * GAME TYPES:
 *   flip     — range:2, payout:2x  (1:1 odds)
 *   dice     — range:6, payout:6x  (5:1 odds)
 *   roulette — range:36, payout:36x (35:1 odds)
 *
 * ============================================================================
 */


/* =========================================================================
 * GAME TYPE DEFINITIONS
 * =========================================================================
 * Each game type defines:
 *   name   — Display name
 *   range  — Number of possible outcomes (0 to range-1)
 *   payout — Multiplier on bet amount if player wins
 *   labels — Human-readable labels for each outcome
 *
 * PAYOUT MATH:
 *   If player bets B and wins: they receive B * payout
 *   Net gain = B * (payout - 1)
 *   Net loss for house = B * (payout - 1)
 *   House needs at least B * (payout - 1) in the channel to cover a loss
 *
 * Example: Player bets 10 on dice (range=6, payout=6)
 *   Win:  player receives 60, net gain = 50
 *   Loss: player receives 0, net loss = 10
 *   House needs at least 50 in their channel balance to cover this bet
 * ========================================================================= */

var GAME_TYPES = {
	flip: {
		name:    "Coin Flip",
		range:   2,
		payout:  2,
		labels:  ["Heads", "Tails"]
	},
	dice: {
		name:    "Dice",
		range:   6,
		payout:  6,
		labels:  ["1", "2", "3", "4", "5", "6"]
	},
	roulette: {
		name:    "Roulette",
		range:   36,
		payout:  36,
		labels:  null  // Generated dynamically: 1-36
	}
};

/**
 * Get the display label for a game result.
 *
 * Internal values are 0-indexed (0 to range-1).
 * Display values are 1-indexed for dice and roulette.
 * Coin flip uses Heads/Tails.
 *
 * @param gametype — "flip", "dice", or "roulette"
 * @param pick     — Internal value (0 to range-1)
 * @returns        — Human-readable label
 */
function getPickLabel(gametype, pick){
	var game = GAME_TYPES[gametype];
	if(!game){ return "Unknown"; }

	if(game.labels){
		return game.labels[pick] || ("Pick "+pick);
	}

	// Roulette: display as 1-36 (internal 0-35)
	return ""+(parseInt(pick) + 1);
}


/* =========================================================================
 * SECRET GENERATION AND COMMITMENT
 * =========================================================================
 * A "secret" is a random 32-byte hex value.
 * A "commit" is SHA3(secret) — the hash of the secret.
 *
 * The commit is shared publicly (sent to the counterparty).
 * The secret is kept private until reveal time.
 *
 * We use Minima's `random` command to generate cryptographically
 * secure random values, and `hash` command for SHA3.
 * ========================================================================= */

/**
 * Generate a new random secret and its SHA3 commitment.
 *
 * @param callback — Returns {secret: "0x...", commit: "0x..."}
 */
function generateSecretAndCommit(callback){

	// Generate 32 random bytes using Minima's cryptographic RNG
	MDS.cmd("random size:32", function(randresp){
		var secret = randresp.response.random;

		// Compute the SHA3 hash of the secret — this is the commitment
		MDS.cmd("hash data:"+secret, function(hashresp){
			var commit = hashresp.response.hash;

			callback({
				secret: secret,
				commit: commit
			});
		});
	});
}

/**
 * Store a secret in MDS.keypair, keyed by its commit hash.
 *
 * IMPORTANT: We key by commit hash, NOT by coinid or channel hashid.
 * Coinids change when the ELTOO coin transitions through phases.
 * Commit hashes are permanent — they're the SHA3 of the secret and
 * never change. This prevents secret loss on phase transitions.
 *
 * We also store the role (house/player) so we can look up secrets
 * by either our commit or the counterparty's commit.
 *
 * @param commit — The SHA3(secret) commitment hash
 * @param secret — The raw secret value
 * @param role   — "house" or "player" — identifies whose secret this is
 */
function storeSecret(commit, secret, role){
	var key = "casino_"+role+"_secret_"+commit;
	MDS.keypair.set(key, secret, function(res){
		if(!res.status){
			MDS.log("WARNING: Failed to store "+role+" secret for commit "+commit);
		}
	});
}

/**
 * Retrieve a stored secret by its commit hash.
 *
 * @param commit   — The SHA3(secret) commitment hash
 * @param role     — "house" or "player"
 * @param callback — Returns the secret string, or null if not found
 */
function retrieveSecret(commit, role, callback){
	var key = "casino_"+role+"_secret_"+commit;
	MDS.keypair.get(key, function(res){
		if(res.status && res.value){
			callback(res.value);
		}else{
			callback(null);
		}
	});
}


/* =========================================================================
 * OUTCOME COMPUTATION
 * =========================================================================
 * The outcome is computed by combining both secrets through SHA3 and
 * extracting a number from the hash. This is done:
 *
 *   1. OFF-CHAIN in JavaScript (for instant game resolution)
 *   2. ON-CHAIN in the MAST dispute script (for trustless verification)
 *
 * Both MUST produce the exact same result. The on-chain version uses:
 *   LET h=SHA3(CONCAT(hs sc))
 *   LET r=NUMBER(SUBSET(0 4 h))%range
 *
 * The off-chain version must replicate this exactly.
 * ========================================================================= */

/**
 * Compute the game outcome from both secrets.
 *
 * This replicates the on-chain KISS VM computation:
 *   SHA3(CONCAT(house_secret, player_secret))
 *   NUMBER(SUBSET(0, 4, hash)) % range
 *
 * We use Minima's `hash` command to ensure the SHA3 implementation
 * matches exactly (same as the Java VM on-chain).
 *
 * @param housesecret  — The house's revealed secret (hex)
 * @param playersecret — The player's secret (hex)
 * @param range        — Number of possible outcomes (2, 6, or 36)
 * @param callback     — Returns {result: number, hash: "0x..."}
 */
function computeOutcome(housesecret, playersecret, range, callback){

	// CONCAT: remove 0x prefix from player secret and append to house secret
	// This matches KISS VM's CONCAT(hs sc) which concatenates hex values
	var combined = housesecret + playersecret.substring(2);

	// SHA3 hash of the combined secrets
	MDS.cmd("hash data:"+combined, function(hashresp){
		var hash = hashresp.response.hash;

		// Extract the first 4 bytes (8 hex chars after "0x" prefix)
		// This matches KISS VM's SUBSET(0, 4, hash)
		var first4bytes = hash.substring(2, 10);

		// Convert to a number
		// This matches KISS VM's NUMBER(SUBSET(0, 4, hash))
		var num = parseInt(first4bytes, 16);

		// Modulo by range to get the result
		// This matches KISS VM's %range
		var result = num % range;

		callback({
			result: result,
			hash:   hash
		});
	});
}


/* =========================================================================
 * BET VALIDATION
 * =========================================================================
 * Before placing a bet, we validate:
 *   1. The player has enough funds in the channel
 *   2. The house has enough funds to cover a potential loss
 *   3. The pick is valid (within range)
 *   4. The bet amount is positive and within limits
 * ========================================================================= */

/**
 * Validate a proposed bet before committing to it.
 *
 * Checks both the player's ability to pay the bet and the house's
 * ability to cover the maximum possible loss.
 *
 * @param sqlrow   — Channel data from database
 * @param betamt   — Proposed bet amount (string or number)
 * @param range    — Game range (2, 6, or 36)
 * @param pick     — Player's chosen number (0 to range-1)
 * @param bettor   — Who is the player (1=user1, 2=user2)
 * @returns        — {valid: boolean, error: string|null}
 */
function validateBet(sqlrow, betamt, range, pick, bettor){

	var bet = new Decimal(betamt);

	// Check 1: Bet amount must be positive
	if(bet.lessThanOrEqualTo(DECIMAL_ZERO)){
		return {valid: false, error: "Bet amount must be positive"};
	}

	// Check 2: Pick must be within range
	var picknum = parseInt(pick);
	if(picknum < 0 || picknum >= range){
		return {valid: false, error: "Pick must be 0 to "+(range-1)+", got "+pick};
	}

	// Check 3: Player must have enough balance to cover the bet
	var playerbalance = (bettor == 1)
		? new Decimal(sqlrow.USER1AMOUNT)
		: new Decimal(sqlrow.USER2AMOUNT);

	if(bet.greaterThan(playerbalance)){
		return {valid: false, error: "Insufficient player balance. Have:"+playerbalance+" Need:"+bet};
	}

	// Check 4: House must have enough balance to cover maximum possible loss
	// If player wins: house pays bet * (payout - 1) = bet * (range - 1)
	var maxhouseLoss = bet.mul(new Decimal(range - 1));
	var housebalance = (bettor == 1)
		? new Decimal(sqlrow.USER2AMOUNT)
		: new Decimal(sqlrow.USER1AMOUNT);

	if(maxhouseLoss.greaterThan(housebalance)){
		return {valid: false, error: "Insufficient house balance to cover potential loss."
			+" House has:"+housebalance+" Max loss:"+maxhouseLoss};
	}

	// Check 5: Bet amount within platform limit
	if(bet.greaterThan(new Decimal(MAX_CHANNEL_AMOUNT))){
		return {valid: false, error: "Bet exceeds maximum: "+MAX_CHANNEL_AMOUNT};
	}

	return {valid: true, error: null};
}


/* =========================================================================
 * GAME ROUND MANAGEMENT
 * =========================================================================
 * A "game round" is a single bet from commit to resolution.
 * The round progresses through these states:
 *
 *   COMMITTED  — Both parties committed secrets and signed pessimistic balance
 *   REVEALED   — House revealed their secret to the player
 *   RESOLVED   — Outcome computed, balance updated, both signed new state
 *   ABANDONED  — Round aborted (house didn't reveal, player reclaimed)
 *
 * The round state is tracked in the SQL gamerounds table.
 * The channel's ELTOO state only changes at COMMITTED (phase→1)
 * and RESOLVED (phase→0 with updated balance).
 * ========================================================================= */

/**
 * Start a new game round as the HOUSE.
 *
 * The house initiates a game by:
 *   1. Generating a secret and computing its SHA3 commitment
 *   2. Storing the secret locally (keyed by commit hash)
 *   3. Sending the commit hash to the player via Maxima
 *
 * The player then responds with their own commit, pick, and bet amount.
 *
 * @param hashid    — Channel identifier
 * @param gametype  — "flip", "dice", or "roulette"
 * @param callback  — Returns {commit: "0x...", gametype, range}
 */
function houseStartRound(hashid, gametype, callback){

	var game = GAME_TYPES[gametype];
	if(!game){
		MDS.log("ERROR: Unknown game type: "+gametype);
		if(callback){ callback(null); }
		return;
	}

	// Generate the house's secret and commitment
	generateSecretAndCommit(function(data){

		// Store the secret permanently, keyed by the commit hash
		// This survives page reloads, tab closes, and MiniDapp updates
		storeSecret(data.commit, data.secret, "house");

		// Log the round start
		insertLog(hashid, "GAME_HOUSE_START",
			"House started "+game.name+" round. Commit:"+data.commit.substring(0,16)+"..");

		callback({
			commit:   data.commit,
			gametype: gametype,
			range:    game.range
		});
	});
}

/**
 * Respond to a game round as the PLAYER.
 *
 * The player has received the house's commit hash. They:
 *   1. Validate the game parameters
 *   2. Generate their own secret and commitment
 *   3. Choose their pick (0 to range-1)
 *   4. Store the secret locally
 *   5. Return commit + pick + bet amount
 *
 * After this, both parties sign the pessimistic balance (handled by
 * channelfunction.js / messages.js).
 *
 * @param hashid       — Channel identifier
 * @param housecommit  — The house's SHA3 commitment (received via Maxima)
 * @param gametype     — "flip", "dice", or "roulette"
 * @param pick         — Player's chosen number (0 to range-1)
 * @param betamt       — How much the player is betting
 * @param callback     — Returns {playercommit, pick, betamt, range} or null
 */
function playerCommitRound(hashid, housecommit, gametype, pick, betamt, callback){

	var game = GAME_TYPES[gametype];
	if(!game){
		MDS.log("ERROR: Unknown game type: "+gametype);
		if(callback){ callback(null); }
		return;
	}

	// Validate the pick
	var picknum = parseInt(pick);
	if(picknum < 0 || picknum >= game.range){
		MDS.log("ERROR: Invalid pick "+pick+" for "+gametype+" (range "+game.range+")");
		if(callback){ callback(null); }
		return;
	}

	// Generate the player's secret and commitment
	generateSecretAndCommit(function(data){

		// Store the player's secret, keyed by their commit
		storeSecret(data.commit, data.secret, "player");

		// Also store the house's commit so we can look up their secret later
		// (after they reveal it to us via Maxima)
		MDS.keypair.set("casino_housecommit_for_"+data.commit, housecommit);

		insertLog(hashid, "GAME_PLAYER_COMMIT",
			"Player committed to "+game.name+" round."
			+" Pick:"+getPickLabel(gametype, picknum)
			+" Bet:"+betamt
			+" Commit:"+data.commit.substring(0,16)+"..");

		callback({
			playercommit: data.commit,
			pick:         picknum,
			betamt:       betamt,
			range:        game.range
		});
	});
}

/**
 * House reveals their secret to the player.
 *
 * Called after both parties have committed and signed the pessimistic
 * balance. The house retrieves their stored secret and sends it to
 * the player via Maxima.
 *
 * SECURITY: The house secret was committed (SHA3) BEFORE seeing the
 * player's commit. They cannot change it now to influence the outcome.
 *
 * @param hashid      — Channel identifier
 * @param housecommit — The house's commit hash (to look up the secret)
 * @param callback    — Returns the house secret string, or null if not found
 */
function houseRevealSecret(hashid, housecommit, callback){

	retrieveSecret(housecommit, "house", function(secret){
		if(!secret){
			MDS.log("ERROR: House secret not found for commit: "+housecommit);
			insertLog(hashid, "GAME_REVEAL_ERROR",
				"Could not find house secret for commit "+housecommit.substring(0,16)
				+".. — keypair may have been lost");
			callback(null);
			return;
		}

		insertLog(hashid, "GAME_HOUSE_REVEAL",
			"House revealed secret. Commit:"+housecommit.substring(0,16)+"..");

		callback(secret);
	});
}

/**
 * Resolve a game round after the house reveals.
 *
 * Called by the player (or auto-resolve in service.js) when the house's
 * secret is received. Computes the outcome and determines the winner.
 *
 * @param hashid       — Channel identifier
 * @param housesecret  — The house's revealed secret
 * @param housecommit  — The house's commit (to verify the secret)
 * @param playercommit — The player's commit (to look up their secret)
 * @param pick         — The player's chosen number
 * @param gametype     — "flip", "dice", or "roulette"
 * @param callback     — Returns {winner: "player"|"house", result, pick,
 *                        housesecret, playersecret, gametype, range} or null
 */
function resolveRound(hashid, housesecret, housecommit, playercommit, pick, gametype, callback){

	var game = GAME_TYPES[gametype];
	if(!game){
		MDS.log("ERROR: Unknown game type: "+gametype);
		if(callback){ callback(null); }
		return;
	}

	// Step 1: Verify the house's secret matches their commitment
	// This is the same check the on-chain MAST script does:
	//   ASSERT SHA3(hs) EQ PREVSTATE(106)
	MDS.cmd("hash data:"+housesecret, function(hashresp){
		var computedcommit = hashresp.response.hash;

		if(computedcommit !== housecommit){
			MDS.log("ERROR: House secret does NOT match commit!");
			MDS.log("  Expected commit: "+housecommit);
			MDS.log("  Got SHA3(secret): "+computedcommit);
			insertLog(hashid, "GAME_CHEAT_DETECTED",
				"House secret does not match commit! CHEATING DETECTED."
				+" Expected:"+housecommit.substring(0,16)
				+" Got:"+computedcommit.substring(0,16));
			if(callback){ callback(null); }
			return;
		}

		// Step 2: Retrieve the player's secret
		retrieveSecret(playercommit, "player", function(playersecret){
			if(!playersecret){
				MDS.log("ERROR: Player secret not found for commit: "+playercommit);
				insertLog(hashid, "GAME_RESOLVE_ERROR",
					"Player secret not found for commit "+playercommit.substring(0,16)+"..");
				if(callback){ callback(null); }
				return;
			}

			// Step 3: Store the house secret for potential future MAST dispute
			// If the house refuses to sign the winning balance, we need this
			// secret to prove on-chain that we won
			storeSecret(housecommit, housesecret, "house_revealed");

			// Step 4: Compute the outcome
			computeOutcome(housesecret, playersecret, game.range, function(outcome){

				var picknum  = parseInt(pick);
				var result   = outcome.result;
				var winner   = (result === picknum) ? "player" : "house";

				insertLog(hashid, "GAME_RESOLVED",
					game.name+" resolved!"
					+" Result:"+getPickLabel(gametype, result)
					+" Pick:"+getPickLabel(gametype, picknum)
					+" Winner:"+winner
					+" Hash:"+outcome.hash.substring(0,16)+"..");

				callback({
					winner:       winner,
					result:       result,
					pick:         picknum,
					housesecret:  housesecret,
					playersecret: playersecret,
					gametype:     gametype,
					range:        game.range,
					hash:         outcome.hash
				});
			});
		});
	});
}


/* =========================================================================
 * BALANCE CALCULATION AFTER GAME RESOLUTION
 * =========================================================================
 * After a game resolves, we need to compute the correct channel balance.
 *
 * Remember: the PESSIMISTIC balance (player lost) is already signed.
 * If the player actually lost, we just clear the game phase (set phase=0)
 * at the same balances. If the player won, we compute winning balances.
 *
 * The payout formula matches the on-chain MAST dispute script:
 *   winnings = betamt * range
 *   If bettor=1 and player won:
 *     user1 = prebetamt1 + winnings - betamt  (= prebetamt1 + betamt*(range-1))
 *     user2 = prebetamt2 - winnings + betamt  (= prebetamt2 - betamt*(range-1))
 * ========================================================================= */

/**
 * Calculate the resolved balance after a game round.
 *
 * @param sqlrow  — Channel data with PREBETAMT1, PREBETAMT2, BETAMOUNT, BETTOR, GAMERANGE
 * @param winner  — "player" or "house"
 * @returns       — {user1amount, user2amount} as Decimal strings
 */
function calculateGameBalance(sqlrow, winner){

	var betamt = new Decimal(sqlrow.BETAMOUNT);
	var range  = new Decimal(sqlrow.GAMERANGE);
	var pre1   = new Decimal(sqlrow.PREBETAMT1);
	var pre2   = new Decimal(sqlrow.PREBETAMT2);
	var bettor = parseInt(sqlrow.BETTOR);

	if(winner === "house"){
		// Player lost — pessimistic balance is already correct
		// Deduction was: player loses betamt, house gains betamt
		if(bettor == 1){
			return {
				user1amount: pre1.sub(betamt).toString(),
				user2amount: pre2.plus(betamt).toString()
			};
		}else{
			return {
				user1amount: pre1.plus(betamt).toString(),
				user2amount: pre2.sub(betamt).toString()
			};
		}
	}else{
		// Player won — compute winning balance
		var winnings = betamt.mul(range);

		if(bettor == 1){
			return {
				user1amount: pre1.plus(winnings).sub(betamt).toString(),
				user2amount: pre2.sub(winnings).plus(betamt).toString()
			};
		}else{
			return {
				user1amount: pre1.sub(winnings).plus(betamt).toString(),
				user2amount: pre2.plus(winnings).sub(betamt).toString()
			};
		}
	}
}
