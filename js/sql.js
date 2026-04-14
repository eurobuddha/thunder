/**
 * ============================================================================
 * THUNDER CASINO — Database Schema and CRUD Operations
 * ============================================================================
 *
 * Uses Minima's built-in H2 SQL database via MDS.sql().
 *
 * THREE TABLES:
 *
 *   channels    — One row per ELTOO channel. Tracks both parties, balances,
 *                 signed transactions, and active game state.
 *
 *   gamerounds  — One row per game round. Tracks the commit-reveal protocol,
 *                 secrets, outcome, and winner. Full audit trail.
 *
 *   logs        — Timestamped event log for every channel action.
 *                 The provably-fair audit trail — every game, every bet,
 *                 every secret, every balance change.
 *
 * NAMING CONVENTION:
 *   SQL column names are UPPERCASE in query results (H2 convention).
 *   Access via: row.HASHID, row.USER1AMOUNT, row.BETAMOUNT, etc.
 *
 * SECURITY:
 *   String values are encoded via encodeStringForDB() before INSERT
 *   and decoded via decodeStringFromDB() after SELECT.
 *   This prevents SQL injection from user-supplied names.
 *
 * ============================================================================
 */


/* =========================================================================
 * DATABASE CREATION AND DESTRUCTION
 * ========================================================================= */

/**
 * Drop all tables. DESTRUCTIVE — only use during development.
 * In production, NEVER uninstall/reinstall — use mds action:update.
 * Uninstall destroys the database and all stored secrets.
 */
function wipeDB(callback){
	MDS.sql("DROP TABLE IF EXISTS `gamerounds`", function(msg){
		MDS.sql("DROP TABLE IF EXISTS `channels`", function(msg){
			MDS.sql("DROP TABLE IF EXISTS `logs`", function(msg){
				MDS.log("DB Wiped (channels + gamerounds + logs)");
				if(callback){ callback(); }
			});
		});
	});
}

/**
 * Create all tables if they don't exist.
 *
 * Called on every MDS.init — safe to call multiple times because
 * of IF NOT EXISTS. New columns added to existing tables must use
 * ALTER TABLE migrations (not shown here — handle in service.js init).
 */
function createDB(callback){

	/* ------------------------------------------------------------------
	 * TABLE: channels
	 * ------------------------------------------------------------------
	 * One row per ELTOO channel. Extended from Thunder 1.0.1 with
	 * game state columns for the active bet (if any).
	 *
	 * The game state columns store the CURRENT bet's data. When a round
	 * resolves, these are cleared. The historical data lives in gamerounds.
	 * ------------------------------------------------------------------ */
	var channelsSQL = "CREATE TABLE IF NOT EXISTS `channels` ( "

		/* ---- Identity ---- */
		+"  `id` bigint auto_increment, "
		+"  `hashid` varchar(256) NOT NULL, "          // Unique channel identifier
		+"  `state` varchar(256) NOT NULL, "            // Channel lifecycle state

		/* ---- Our role in the channel ---- */
		+"  `usernum` int NOT NULL, "                   // Are we user1 (1) or user2 (2)?
		+"  `userpublickey` varchar(256), "             // Our ELTOO signing key

		/* ---- User 1 details ---- */
		+"  `user1name` varchar(1024), "                // Display name (from Maxima)
		+"  `user1maximaid` varchar(1024), "            // Maxima public key (for messaging)
		+"  `user1publickey` varchar(256), "            // ELTOO signing key
		+"  `user1address` varchar(256), "              // Payout address (LOCKED at creation)
		+"  `user1amount` varchar(256), "               // Current balance in channel

		/* ---- User 2 details ---- */
		+"  `user2name` varchar(1024), "
		+"  `user2maximaid` varchar(1024),"
		+"  `user2publickey` varchar(256),"
		+"  `user2address` varchar(256),"               // Payout address (LOCKED at creation)
		+"  `user2amount` varchar(256),"                // Current balance in channel

		/* ---- Token details ---- */
		+"  `tokenname` varchar(256),"
		+"  `tokenid` varchar(256),"
		+"  `tokendata` varchar(256000),"

		/* ---- Channel financials ---- */
		+"  `totalamount` varchar(256),"                // Total locked in channel (constant)

		/* ---- On-chain addresses ---- */
		+"  `fundingaddress` varchar(256),"             // 2-of-2 multisig funding address
		+"  `eltooaddress` varchar(256),"               // ELTOO state channel address

		/* ---- ELTOO state ---- */
		+"  `sequence` bigint,"                         // Current sequence number

		/* ---- Signed transactions (hex-encoded) ---- */
		+"  `triggertxn` varchar(256000),"              // Both-signed trigger
		+"  `settletxn` varchar(256000),"               // Both-signed latest settlement
		+"  `updatetxn` varchar(256000),"               // Both-signed latest update

		/* ---- Close tracking ---- */
		+"  `fundingspent` int NOT NULL default 0,"     // 1 = funding coin has been spent
		+"  `payoutfound` int NOT NULL default 0,"      // 1 = our payout coin found
		+"  `payoutamount` varchar(256) NOT NULL default '0',"

		/* ---- GAME STATE (active bet, cleared on resolution) ---- */
		+"  `gamephase` int NOT NULL default 0,"        // 0=idle, 1=bet active
		+"  `gametype` varchar(32) default '',"         // flip, dice, roulette
		+"  `gamerange` int default 0,"                 // 2, 6, or 36
		+"  `betamount` varchar(256) default '0',"      // How much is wagered
		+"  `bettor` int default 0,"                    // Who is the player (1 or 2)
		+"  `playerpick` int default 0,"                // Player's chosen number
		+"  `playercommit` varchar(256) default '',"    // SHA3(player_secret)
		+"  `housecommit` varchar(256) default '',"     // SHA3(house_secret)
		+"  `housesecret` varchar(256) default '',"     // Revealed house secret (after reveal)
		+"  `playersecret` varchar(256) default '',"    // Player's secret (after resolve)
		+"  `prebetamt1` varchar(256) default '0',"     // User 1 balance before this bet
		+"  `prebetamt2` varchar(256) default '0',"     // User 2 balance before this bet
		+"  `gameresult` varchar(32) default '',"       // WIN, LOSS, or empty
		+"  `gameroundid` int default 0,"               // Links to gamerounds table

		/* ---- Timestamp ---- */
		+"  `date` bigint NOT NULL "
		+" )";

	MDS.sql(channelsSQL, function(msg){

		/* ------------------------------------------------------------------
		 * TABLE: gamerounds
		 * ------------------------------------------------------------------
		 * Full history of every game round played in every channel.
		 * This is the provably-fair audit trail — every secret, every
		 * commit, every outcome, every balance change is recorded.
		 *
		 * Even after a channel closes, this table retains the history.
		 * A player can verify any past game by checking:
		 *   SHA3(housesecret) == housecommit
		 *   SHA3(playersecret) == playercommit
		 *   NUMBER(SUBSET(0,4, SHA3(CONCAT(housesecret, playersecret)))) % range == result
		 * ------------------------------------------------------------------ */
		var gameroundsSQL = "CREATE TABLE IF NOT EXISTS `gamerounds` ( "
			+"  `id` bigint auto_increment, "

			/* ---- Identity ---- */
			+"  `hashid` varchar(256) NOT NULL, "       // Channel this round belongs to
			+"  `round` int NOT NULL, "                  // Round number within channel (1, 2, 3...)

			/* ---- Game parameters ---- */
			+"  `gametype` varchar(32) NOT NULL, "       // flip, dice, roulette
			+"  `gamerange` int NOT NULL, "              // 2, 6, 36
			+"  `betamount` varchar(256) NOT NULL, "     // How much was wagered
			+"  `bettor` int NOT NULL, "                 // Who was the player (1 or 2)
			+"  `playerpick` int NOT NULL, "             // What the player chose (0 to range-1)

			/* ---- Commit-reveal data ---- */
			+"  `playercommit` varchar(256), "           // SHA3(player_secret)
			+"  `housecommit` varchar(256), "            // SHA3(house_secret)
			+"  `housesecret` varchar(256), "            // The revealed house secret
			+"  `playersecret` varchar(256), "           // The revealed player secret
			+"  `combinehash` varchar(256), "            // SHA3(CONCAT(house, player))

			/* ---- Outcome ---- */
			+"  `result` int default -1, "               // The computed result (0 to range-1)
			+"  `winner` varchar(32) default '', "       // player or house
			+"  `balanceafter1` varchar(256), "          // User 1 balance after this round
			+"  `balanceafter2` varchar(256), "          // User 2 balance after this round

			/* ---- State ---- */
			+"  `roundstate` varchar(64) NOT NULL, "     // committed, revealed, resolved, abandoned

			/* ---- Timestamp ---- */
			+"  `date` bigint NOT NULL "
			+" )";

		MDS.sql(gameroundsSQL, function(msg){

			/* ------------------------------------------------------------------
			 * TABLE: logs
			 * ------------------------------------------------------------------
			 * Timestamped event log. Every action is recorded here:
			 * channel events, game events, MAST disputes, errors.
			 * ------------------------------------------------------------------ */
			var logsSQL = "CREATE TABLE IF NOT EXISTS `logs` ( "
				+"  `id` bigint auto_increment, "
				+"  `hashid` varchar(256) NOT NULL, "
				+"  `type` varchar(256) NOT NULL, "
				+"  `message` varchar(4096) NOT NULL, "
				+"  `date` bigint NOT NULL "
				+" )";

			MDS.sql(logsSQL, function(msg){
				if(callback){ callback(msg); }
			});
		});
	});
}


/* =========================================================================
 * CHANNEL CRUD
 * ========================================================================= */

/**
 * Insert a new channel record when a channel request is received/sent.
 */
function sqlInsertNewChannel(details, state, usernum, callback){
	var sql = "INSERT INTO channels(hashid, state, usernum, user1name, user1maximaid, user1publickey, user1address, user1amount, "
		+"user2maximaid, user2amount, tokenname, tokenid, tokendata, totalamount, date) "
		+"VALUES ('"+details.hashid+"','"+state+"',"+usernum+",'"
		+encodeStringForDB(details.user.name)+"','"+details.user.maximaid+"','"+details.user.publickey+"','"+details.user.address+"','"+details.useramount
		+"','"+details.tomaximapublickey
		+"','"+details.requestamount
		+"','"+encodeStringForDB(details.tokenname)
		+"','"+details.tokenid
		+"','"+details.tokendata
		+"','"+details.totalamount
		+"',"+getTimeMilli()+")";

	MDS.sql(sql, function(msg){
		if(callback){ callback(msg); }
	});
}

/** Select ALL channels */
function sqlSelectAllChannels(callback){
	MDS.sql("SELECT * FROM channels", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Select channels that are NOT closed */
function sqlSelectAllOpenChannels(callback){
	MDS.sql("SELECT * FROM channels WHERE state !='STATE_CHANNEL_CLOSED'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Select only CLOSED channels (for history view) */
function sqlSelectAllClosedChannels(callback){
	MDS.sql("SELECT * FROM channels WHERE state ='STATE_CHANNEL_CLOSED'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Delete all closed channels (clear history) */
function sqlDeleteAllClosedChannels(callback){
	MDS.sql("DELETE FROM channels WHERE state ='STATE_CHANNEL_CLOSED'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Select ELTOO-relevant data for all channels (for block monitoring) */
function sqlSelectEltooChannels(callback){
	MDS.sql("SELECT hashid, state, eltooaddress, sequence FROM channels", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Select a specific channel by hashid */
function sqlSelectChannel(hashid, callback){
	MDS.sql("SELECT * FROM channels WHERE hashid='"+hashid+"'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Find channels by funding address (for NEWCOIN tracking) */
function sqlSelectRelevantFundingCoin(address, callback){
	MDS.sql("SELECT * FROM channels WHERE fundingaddress='"+address+"'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Find channels by ELTOO address (for NEWCOIN tracking) */
function sqlSelectRelevantEltooCoin(address, callback){
	MDS.sql("SELECT * FROM channels WHERE eltooaddress='"+address+"'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Find channels by payout address (for settlement tracking) */
function sqlSelectPayoutCoin(address, callback){
	MDS.sql("SELECT * FROM channels WHERE user1address='"+address+"' OR user2address='"+address+"'", function(msg){
		if(callback){ callback(msg); }
	});
}


/* =========================================================================
 * CHANNEL UPDATES
 * ========================================================================= */

/** Update our public key on the channel */
function updateMyPublicKey(hashid, publickey, callback){
	MDS.sql("UPDATE channels SET userpublickey='"+publickey+"' WHERE hashid='"+hashid+"'", function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/** Update channel lifecycle state */
function updateChannelState(hashid, state, callback){
	MDS.sql("UPDATE channels SET state='"+state+"' WHERE hashid='"+hashid+"'", function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/** Update User 2's details (name, pubkey, address) */
function updateChannelUser2(hashid, user, callback){
	var sql = "UPDATE channels SET user2name='"+encodeStringForDB(user.name)
		+"', user2publickey='"+user.publickey
		+"', user2address='"+user.address+"' WHERE hashid='"+hashid+"'";
	MDS.sql(sql, function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/** Update the funding and ELTOO addresses after channel creation */
function updateChannelAddresses(hashid, alldata, callback){
	var sql = "UPDATE channels SET fundingaddress='"+alldata.addresses.fundingaddress.address
		+"', eltooaddress='"+alldata.addresses.eltooaddress.address
		+"', sequence=0 WHERE hashid='"+hashid+"'";
	MDS.sql(sql, function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/** Store the initial signed trigger and settlement transactions */
function updateDefaultChannelTransactions(hashid, alldata, callback){
	var sql = "UPDATE channels SET triggertxn='"+alldata.transactions.triggertxn
		+"', settletxn='"+alldata.transactions.settletxn
		+"', sequence=0 WHERE hashid='"+hashid+"'";
	MDS.sql(sql, function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/**
 * Update to a new sequence with new settlement and update transactions.
 * Called after every balance change (send, game bet, game resolve).
 */
function updateNewSequenceTxn(hashid, sequence, user1amount, user2amount, settletxn, updatetxn, callback){
	var sql = "UPDATE channels SET settletxn='"+settletxn
		+"', updatetxn='"+updatetxn+"',"
		+"user1amount='"+user1amount+"', user2amount='"+user2amount+"',"
		+" sequence="+sequence+" WHERE hashid='"+hashid+"'";
	MDS.sql(sql, function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/** Mark funding as spent (channel is closing) */
function updateFundingSpent(hashid, callback){
	MDS.sql("UPDATE channels SET fundingspent=1, state='STATE_CHANNEL_START_CLOSE' WHERE hashid='"+hashid+"'", function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/** Mark payout as found (channel close complete) */
function updatePayoutFound(hashid, amount, callback){
	MDS.sql("UPDATE channels SET payoutfound=1, payoutamount='"+amount+"' WHERE hashid='"+hashid+"'", function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/**
 * Auto-close channels that are done:
 *   - Funding spent AND payout found → fully closed
 *   - Request cancelled or denied → no longer needed
 */
function updateClosedChannels(callback){
	var where = " state!='STATE_CHANNEL_CLOSED' AND ("
		+"(fundingspent=1 AND payoutfound=1) OR "
		+"state='STATE_REQUEST_CANCELLED' OR "
		+"state='STATE_REQUEST_DENIED')";

	MDS.sql("SELECT hashid, state, fundingspent, payoutfound FROM channels WHERE "+where, function(checkmsg){
		var closedfound = (checkmsg.count > 0);

		// Log each channel being closed
		for(var i=0; i<checkmsg.count; i++){
			insertLog(checkmsg.rows[i].HASHID, "CHANNEL_CLOSE", "The channel was successfully closed");
		}

		if(closedfound){
			MDS.sql("UPDATE channels SET state='STATE_CHANNEL_CLOSED' WHERE "+where, function(msg){
				if(callback){ callback(true); }
			});
		}else{
			if(callback){ callback(false); }
		}
	});
}


/* =========================================================================
 * GAME STATE UPDATES ON CHANNELS
 * =========================================================================
 * These functions update the active game state on a channel row.
 * The game state is stored directly on the channel because there's
 * only ever ONE active game per channel at a time.
 * ========================================================================= */

/**
 * Set the active game state when a bet is placed (pessimistic commit signed).
 *
 * Stores all the commit-reveal data needed for potential MAST dispute.
 * Also snapshots the pre-bet balances so we can restore them if needed.
 *
 * @param hashid       — Channel identifier
 * @param gametype     — "flip", "dice", or "roulette"
 * @param range        — 2, 6, or 36
 * @param betamt       — How much is wagered
 * @param bettor       — Who is the player (1 or 2)
 * @param pick         — Player's chosen number
 * @param playercommit — SHA3(player_secret)
 * @param housecommit  — SHA3(house_secret)
 * @param prebetamt1   — User 1 balance before the bet
 * @param prebetamt2   — User 2 balance before the bet
 * @param callback     — Returns updated channel row
 */
function updateGameBetActive(hashid, gametype, range, betamt, bettor, pick,
	playercommit, housecommit, prebetamt1, prebetamt2, callback){

	var sql = "UPDATE channels SET "
		+"gamephase=1,"
		+"gametype='"+gametype+"',"
		+"gamerange="+range+","
		+"betamount='"+betamt+"',"
		+"bettor="+bettor+","
		+"playerpick="+pick+","
		+"playercommit='"+playercommit+"',"
		+"housecommit='"+housecommit+"',"
		+"prebetamt1='"+prebetamt1+"',"
		+"prebetamt2='"+prebetamt2+"',"
		+"housesecret='',"
		+"playersecret='',"
		+"gameresult=''"
		+" WHERE hashid='"+hashid+"'";

	MDS.sql(sql, function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/**
 * Store the house's revealed secret (received via Maxima GAME_REVEAL).
 */
function updateGameHouseRevealed(hashid, housesecret, callback){
	MDS.sql("UPDATE channels SET housesecret='"+housesecret+"' WHERE hashid='"+hashid+"'", function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/**
 * Store the game result after resolution.
 * gameresult is "WIN" or "LOSS" from OUR perspective (the bettor's perspective).
 */
function updateGameResult(hashid, playersecret, gameresult, callback){
	MDS.sql("UPDATE channels SET playersecret='"+playersecret+"', gameresult='"+gameresult+"' WHERE hashid='"+hashid+"'", function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}

/**
 * Clear the active game state after a round is fully resolved.
 * The channel goes back to idle (phase=0), ready for the next game.
 */
function updateGameCleared(hashid, callback){
	var sql = "UPDATE channels SET "
		+"gamephase=0,"
		+"gametype='',"
		+"gamerange=0,"
		+"betamount='0',"
		+"bettor=0,"
		+"playerpick=0,"
		+"playercommit='',"
		+"housecommit='',"
		+"housesecret='',"
		+"playersecret='',"
		+"gameresult='',"
		+"prebetamt1='0',"
		+"prebetamt2='0',"
		+"gameroundid=0"
		+" WHERE hashid='"+hashid+"'";

	MDS.sql(sql, function(msg){
		sqlSelectChannel(hashid, function(select){
			if(callback){ callback(select.rows[0]); }
		});
	});
}


/* =========================================================================
 * GAME ROUNDS CRUD (audit trail)
 * ========================================================================= */

/**
 * Insert a new game round when a bet is committed.
 * Returns the auto-generated round ID for linking to the channel row.
 */
function insertGameRound(hashid, round, gametype, range, betamt, bettor, pick,
	playercommit, housecommit, callback){

	var sql = "INSERT INTO gamerounds(hashid, round, gametype, gamerange, betamount, bettor, "
		+"playerpick, playercommit, housecommit, roundstate, date) "
		+"VALUES ('"+hashid+"',"+round+",'"+gametype+"',"+range+",'"
		+betamt+"',"+bettor+","+pick+",'"
		+playercommit+"','"+housecommit+"','committed',"+getTimeMilli()+")";

	MDS.sql(sql, function(msg){
		// Get the last inserted ID for linking
		MDS.sql("SELECT MAX(id) AS MAXID FROM gamerounds WHERE hashid='"+hashid+"'", function(idres){
			var roundid = (idres.count > 0) ? idres.rows[0].MAXID : 0;
			if(callback){ callback(roundid); }
		});
	});
}

/**
 * Update a game round when the house reveals their secret.
 */
function updateGameRoundRevealed(hashid, round, housesecret, callback){
	var sql = "UPDATE gamerounds SET housesecret='"+housesecret+"', roundstate='revealed'"
		+" WHERE hashid='"+hashid+"' AND round="+round;
	MDS.sql(sql, function(msg){
		if(callback){ callback(msg); }
	});
}

/**
 * Update a game round when the outcome is resolved.
 * Records both secrets, the combined hash, the result, the winner,
 * and the post-game balances. This is the permanent audit record.
 */
function updateGameRoundResolved(hashid, round, playersecret, combinehash,
	result, winner, balanceafter1, balanceafter2, callback){

	var sql = "UPDATE gamerounds SET "
		+"playersecret='"+playersecret+"',"
		+"combinehash='"+combinehash+"',"
		+"result="+result+","
		+"winner='"+winner+"',"
		+"balanceafter1='"+balanceafter1+"',"
		+"balanceafter2='"+balanceafter2+"',"
		+"roundstate='resolved'"
		+" WHERE hashid='"+hashid+"' AND round="+round;

	MDS.sql(sql, function(msg){
		if(callback){ callback(msg); }
	});
}

/**
 * Mark a game round as abandoned (timeout, error, channel close mid-game).
 */
function updateGameRoundAbandoned(hashid, round, callback){
	var sql = "UPDATE gamerounds SET roundstate='abandoned'"
		+" WHERE hashid='"+hashid+"' AND round="+round;
	MDS.sql(sql, function(msg){
		if(callback){ callback(msg); }
	});
}

/**
 * Get all game rounds for a channel (for history display).
 * Ordered by round number ascending.
 */
function selectGameRounds(hashid, callback){
	MDS.sql("SELECT * FROM gamerounds WHERE hashid='"+hashid+"' ORDER BY round ASC", function(msg){
		if(callback){ callback(msg); }
	});
}

/**
 * Get the latest round number for a channel (to calculate next round #).
 */
function selectLatestRoundNumber(hashid, callback){
	MDS.sql("SELECT MAX(round) AS MAXROUND FROM gamerounds WHERE hashid='"+hashid+"'", function(msg){
		var maxround = 0;
		if(msg.count > 0 && msg.rows[0].MAXROUND !== null){
			maxround = parseInt(msg.rows[0].MAXROUND);
		}
		if(callback){ callback(maxround); }
	});
}


/* =========================================================================
 * LOGGING
 * =========================================================================
 * Every action is logged with a timestamp, channel hashid, event type,
 * and human-readable message. This is the audit trail that makes the
 * platform provably fair and transparent.
 * ========================================================================= */

var PRINT_LOGS = true;

/**
 * Insert a log entry.
 *
 * @param hashid  — Channel identifier (or "0x00" for global events)
 * @param type    — Event type (e.g., "GAME_RESOLVED", "MAST_HOUSE_CLAIM")
 * @param message — Human-readable description
 */
function insertLog(hashid, type, message, callback){
	if(PRINT_LOGS){
		MDS.log(hashid+"> "+type+": "+message);
	}
	var sql = "INSERT INTO logs(hashid, type, message, date) "
		+"VALUES ('"+hashid+"','"+type+"','"+encodeStringForDB(message)+"',"+getTimeMilli()+")";
	MDS.sql(sql, function(msg){
		if(callback){ callback(msg); }
	});
}

/**
 * Get all log entries for a channel.
 */
function getLogs(hashid, callback){
	MDS.sql("SELECT * FROM logs WHERE hashid='"+hashid+"'", function(msg){
		if(callback){ callback(msg); }
	});
}


/* =========================================================================
 * PROPS TABLE + CRUD
 * =========================================================================
 * One row per proposition bet. Tracks the full lifecycle from offer
 * through settlement.
 * ========================================================================= */

/**
 * Create the props table. Called from createDB.
 * NOTE: This needs to be added to the createDB chain.
 * For now it's a separate function called on init.
 */
function createPropsTable(callback){
	var sql = "CREATE TABLE IF NOT EXISTS `props` ( "
		+"  `id` bigint auto_increment, "
		+"  `hashid` varchar(256) NOT NULL, "          // Channel
		+"  `proposition` varchar(1024) NOT NULL, "    // The bet text
		+"  `proposer` int NOT NULL, "                 // Who proposed (1 or 2)
		+"  `proposerside` varchar(16) NOT NULL, "     // TRUE or FALSE
		+"  `mystake` varchar(256) NOT NULL, "         // Proposer's stake
		+"  `wantstake` varchar(256) NOT NULL, "       // What they want from taker
		+"  `propstate` varchar(64) NOT NULL, "        // offered, active, settling, agreed, disputed
		+"  `proposeroutcome` varchar(16) default '', " // Proposer's verdict
		+"  `takeroutcome` varchar(16) default '', "    // Taker's verdict
		+"  `finaloutcome` varchar(16) default '', "    // Agreed outcome
		+"  `date` bigint NOT NULL "
		+" )";
	MDS.sql(sql, function(msg){
		if(callback){ callback(msg); }
	});
}

/** Insert a new prop */
function insertProp(hashid, proposition, proposer, side, mystake, wantstake, callback){
	var sql = "INSERT INTO props(hashid, proposition, proposer, proposerside, mystake, wantstake, propstate, date) "
		+"VALUES ('"+hashid+"','"+encodeStringForDB(proposition)+"',"+proposer+",'"+side+"','"
		+mystake+"','"+wantstake+"','offered',"+getTimeMilli()+")";
	MDS.sql(sql, function(msg){
		if(callback){ callback(msg); }
	});
}

/** Get the active prop for a channel */
function selectActiveProp(hashid, callback){
	MDS.sql("SELECT * FROM props WHERE hashid='"+hashid+"' AND propstate NOT IN ('agreed','disputed','expired','cancelled') ORDER BY id DESC LIMIT 1", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Get all props for a channel (history) */
function selectAllProps(hashid, callback){
	MDS.sql("SELECT * FROM props WHERE hashid='"+hashid+"' ORDER BY date DESC", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Update prop state */
function updatePropState(hashid, propstate, callback){
	MDS.sql("UPDATE props SET propstate='"+propstate+"' WHERE hashid='"+hashid+"' AND propstate NOT IN ('agreed','disputed','expired','cancelled')", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Record one side's outcome vote */
function updatePropOutcome(hashid, who, outcome, callback){
	var col = (who === 'proposer') ? 'proposeroutcome' : 'takeroutcome';
	MDS.sql("UPDATE props SET "+col+"='"+outcome+"', propstate='settling' WHERE hashid='"+hashid+"' AND propstate IN ('active','settling')", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Record final agreed outcome */
function updatePropAgreed(hashid, outcome, callback){
	MDS.sql("UPDATE props SET finaloutcome='"+outcome+"', propstate='agreed' WHERE hashid='"+hashid+"'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Record dispute */
function updatePropDisputed(hashid, callback){
	MDS.sql("UPDATE props SET propstate='disputed' WHERE hashid='"+hashid+"'", function(msg){
		if(callback){ callback(msg); }
	});
}

/** Update channel with prop data (for MAST dispute) */
function updateChannelPropActive(hashid, proposition, proposer, mystake, wantstake, side, callback){
	var sql = "UPDATE channels SET "
		+"gamephase=2,"                                    // 2 = prop active
		+"gametype='prop',"
		+"betamount='"+mystake+"',"
		+"bettor="+proposer+","
		+"prebetamt1=user1amount,"
		+"prebetamt2=user2amount"
		+" WHERE hashid='"+hashid+"'";
	MDS.sql(sql, function(msg){
		// Also store prop-specific data
		MDS.sql("UPDATE channels SET "
			+"playercommit='"+encodeStringForDB(proposition)+"',"
			+"housecommit='"+wantstake+"',"                   // Reuse housecommit for wantstake
			+"playerpick="+((side==='TRUE')?1:0)+","
			+"gamerange=0"
			+" WHERE hashid='"+hashid+"'", function(msg2){
				sqlSelectChannel(hashid, function(sel){
					if(callback){ callback(sel.rows[0]); }
				});
			});
	});
}
