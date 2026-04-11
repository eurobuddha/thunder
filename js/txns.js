/**
 * ============================================================================
 * THUNDER CASINO — Transaction Construction Library
 * ============================================================================
 *
 * This file handles ALL on-chain transaction building for the Thunder Casino
 * ELTOO payment channel. It is forked from Thunder v1.0.1 and extended with
 * game-aware state ports and MAST dispute settlement paths.
 *
 * ARCHITECTURE OVERVIEW:
 *
 *   1. FUNDING   — 2-of-2 multisig holding the channel's total funds
 *   2. TRIGGER   — spends funding → ELTOO address at sequence 0
 *   3. UPDATE    — replaces ELTOO coin with higher sequence (settlement=FALSE)
 *   4. SETTLEMENT— splits ELTOO coin to user addresses (settlement=TRUE)
 *   5. MAST      — dispute settlement paths (claim/reclaim/dispute)
 *
 * SECURITY RULES (from Limit minArmyKnife incident 2026-04-11):
 *   - EVERY spending path has VERIFYOUT — no unguarded SIGNEDBY
 *   - Addresses come from PREVSTATE, never from getaddress at runtime
 *   - txndelete on every error path — no zombie transactions
 *   - No txnpost auto:true — always txnsign → txnbasics → txnpost
 *   - All STATE ports the script reads MUST be explicitly set
 *
 * STATE PORT MAP:
 *   100: settlement flag    (TRUE = settle, FALSE = update)
 *   101: sequence number    (monotonically increasing)
 *   102: game phase         (0 = idle/no game, 1 = bet in progress)
 *   103: bet amount         (how much the player wagered)
 *   104: range              (2=flip, 6=dice, 36=roulette)
 *   105: player commit hash (SHA3 of player's secret)
 *   106: house commit hash  (SHA3 of house's secret)
 *   107: player pick        (0 to range-1, the number they chose)
 *   108: bettor indicator   (1=user1 is player, 2=user2 is player)
 *   109: user1 payout addr  (locked at channel creation, from PREVSTATE)
 *   110: user2 payout addr  (locked at channel creation, from PREVSTATE)
 *   111: user1 pre-bet amt  (balance before this bet was placed)
 *   112: user2 pre-bet amt  (balance before this bet was placed)
 *   113: house secret       (only used in dispute STATE, not stored on coin)
 *   114: player secret      (only used in dispute STATE, not stored on coin)
 *   115: user1 public key   (for MAST SIGNEDBY verification)
 *   116: user2 public key   (for MAST SIGNEDBY verification)
 *   200: hashid             (channel identifier, used for payout tracking)
 *
 * ============================================================================
 */


/* =========================================================================
 * SCRIPT TEMPLATES
 * =========================================================================
 * These templates have placeholders (#HASHID, #USER1, #USER2, etc.)
 * that get replaced with real values when a channel is created.
 * Each channel gets a unique script address because of the unique #HASHID.
 * ========================================================================= */

/**
 * FUNDING SCRIPT — Simple 2-of-2 multisig
 *
 * Both users must sign to spend the funding. This is the on-chain UTXO
 * that holds the channel's total funds. The #HASHID makes each channel's
 * funding address unique, even between the same two users.
 */
var FUNDING_SCRIPT = "LET randid=[#HASHID] RETURN MULTISIG(2 #USER1 #USER2)";

/**
 * ELTOO SCRIPT — Game-Aware State Channel Contract
 *
 * This is the core contract that enforces the channel rules on-chain.
 * It handles two operations:
 *
 *   UPDATE (settlement=FALSE):
 *     - New sequence must be strictly greater than previous
 *     - Both users must sign (MULTISIG)
 *     - Used to post the latest state during unilateral close
 *
 *   SETTLEMENT (settlement=TRUE):
 *     - Sequence must match (no newer state exists)
 *     - Coin must be old enough (@COINAGE >= timeout)
 *     - Both users must sign (MULTISIG)
 *     - ONLY allowed when game phase = 0 (no active bet)
 *
 * When a game IS active (phase=1), settlement is BLOCKED in the main script.
 * All phase=1 settlements MUST go through MAST dispute branches, which have
 * their own SIGNEDBY + VERIFYOUT enforcement. This prevents any app from
 * settling a channel mid-game and stealing the bet amount.
 *
 * The MAST root hash (from mast.js) is embedded in the script, enabling
 * 3 dispute branches: house-claim, player-reclaim, player-dispute.
 */
var ELTOO_SCRIPT = "LET rid=[#HASHID] "
	+"LET st=STATE(100) LET sq=STATE(101) LET ps=PREVSTATE(101) "
	+"ASSERT MULTISIG(2 #USER1 #USER2) "
	+"IF st EQ FALSE THEN IF sq GT ps THEN RETURN TRUE ENDIF RETURN FALSE ENDIF "
	+"LET gp=PREVSTATE(102) "
	+"IF gp EQ 0 AND sq EQ ps AND @COINAGE GTE #TIMEOUT THEN RETURN TRUE ENDIF "
	+"MAST "+MAST_ROOT+" "
	+"RETURN FALSE";


/* =========================================================================
 * CONSTANTS
 * =========================================================================
 * These control timing and limits for the channel protocol.
 * ========================================================================= */

/**
 * MIN_UPDATE_COINAGE — Blocks to wait before posting an update
 * after a trigger. Gives the counterparty time to post a newer update.
 * Also used as the ELTOO script's #TIMEOUT for normal settlement.
 */
var MIN_UPDATE_COINAGE = 5;

/**
 * MIN_SETTLE_COINAGE — Blocks to wait before posting a settlement.
 * Must be long enough for the counterparty to respond with a newer update.
 * The MAST branches have their own longer timeouts (32, 256, 1024 blocks).
 */
var MIN_SETTLE_COINAGE = 30;

/**
 * MAX_CHANNEL_AMOUNT — Maximum total value in a channel.
 * Limits exposure during testing. Can be increased for production.
 */
var MAX_CHANNEL_AMOUNT = 1000;


/* =========================================================================
 * UTILITY — Random transaction IDs
 * =========================================================================
 * Every Minima transaction needs a unique ID while it's being constructed.
 * We generate a random 16-char hex string for each transaction.
 * These are temporary — the txn is exported and deleted after construction.
 * ========================================================================= */

function randomString() {
	const hex = '0123456789ABCDEF';
	let output = '';
	for (let i = 0; i < 16; ++i) {
		output += hex.charAt(Math.floor(Math.random() * hex.length));
	}
	return output;
}


/* =========================================================================
 * ADDRESS CREATION
 * =========================================================================
 * These functions create the two special addresses used by each channel:
 *   1. Funding address — holds the channel's total locked funds
 *   2. ELTOO address   — the state channel contract address
 *
 * Both addresses are unique per channel because they include the #HASHID.
 * Both addresses are unique per user pair because they include both pubkeys.
 * ========================================================================= */

/**
 * Create the FUNDING address for a channel.
 *
 * This is a simple 2-of-2 multisig. Both users send funds here to open
 * the channel. The funding can only be spent when both users sign.
 *
 * The `runscript` command computes the script's hash to get the address.
 * We store both the script text (needed to track it) and the address.
 *
 * @param hashid       — Unique channel identifier (random hex)
 * @param user1pubkey  — User 1's Minima public key
 * @param user2pubkey  — User 2's Minima public key
 * @param callback     — Returns {script: "...", address: "Mx..."}
 */
function createFundingAddress(hashid, user1pubkey, user2pubkey, callback){

	// Replace placeholders with real values for this specific channel
	var script = FUNDING_SCRIPT
		.replace("#HASHID", hashid)
		.replace("#USER1", user1pubkey)
		.replace("#USER2", user2pubkey);

	// Ask Minima to compute the script hash → gives us the address
	MDS.cmd("runscript script:\""+script+"\"", function(scriptresp){
		var ret = {};
		ret.script  = scriptresp.response.clean.script;   // Canonical form
		ret.address = scriptresp.response.clean.mxaddress; // Mx... address
		callback(ret);
	});
}

/**
 * Create the ELTOO address for a channel.
 *
 * This is the game-aware state channel contract. It includes the MAST root
 * hash so dispute branches can be executed when a game is active.
 *
 * The timeout parameter controls how many blocks a settlement coin must age
 * before it can be spent. This gives the counterparty time to post a newer
 * update if someone tries to settle with an old state.
 *
 * @param hashid       — Unique channel identifier
 * @param user1pubkey  — User 1's Minima public key
 * @param user2pubkey  — User 2's Minima public key
 * @param timeout      — Blocks required for @COINAGE check (MIN_UPDATE_COINAGE)
 * @param callback     — Returns {script: "...", address: "Mx..."}
 */
function createELTOOAddress(hashid, user1pubkey, user2pubkey, timeout, callback){

	// Replace all placeholders — including the MAST root from mast.js
	// Note: MAST_ROOT is already embedded in the ELTOO_SCRIPT template
	var script = ELTOO_SCRIPT
		.replace("#HASHID", hashid)
		.replace("#USER1", user1pubkey)
		.replace("#USER2", user2pubkey)
		.replace("#TIMEOUT", timeout);

	// Compute the script address
	MDS.cmd("runscript script:\""+script+"\"", function(scriptresp){
		var ret = {};
		ret.script  = scriptresp.response.clean.script;
		ret.address = scriptresp.response.clean.mxaddress;
		callback(ret);
	});
}


/* =========================================================================
 * SCRIPT TRACKING
 * =========================================================================
 * Minima nodes must "track" a script to detect transactions involving it.
 * trackall:true means the node watches for ALL coins at this address,
 * not just ones with relevant state variables.
 *
 * We track both the funding address and the ELTOO address so our node
 * receives NEWCOIN events when coins appear/disappear at these addresses.
 * This is how the service.js background process monitors the channel.
 * ========================================================================= */

/**
 * Track a script address so we receive events for coins at that address.
 * Must be called when a channel is created, before the funding tx is posted.
 */
function trackScript(script, callback){
	MDS.cmd("newscript trackall:true script:\""+script+"\"", function(scriptresp){
		if(callback){ callback(scriptresp); }
	});
}

/**
 * Stop tracking a script address. Called when a channel is fully closed
 * and we no longer need to monitor it.
 */
function removeScript(address, callback){
	MDS.cmd("removescript address:"+address, function(scriptresp){
		if(callback){ callback(scriptresp); }
	});
}


/* =========================================================================
 * FUNDING TRANSACTION
 * =========================================================================
 * The funding transaction creates the channel's on-chain UTXO.
 * User 1 creates it with their contribution, then User 2 adds theirs.
 * The output goes to the 2-of-2 FUNDING address.
 * ========================================================================= */

/**
 * Create the initial funding transaction.
 *
 * This creates a transaction with:
 *   - Output: total channel amount → funding multisig address
 *   - Input:  user's contribution (via txnaddamount)
 *
 * The transaction is exported as hex data (not posted yet) so the
 * counterparty can add their funds and both can sign.
 *
 * @param fundingaddress — The 2-of-2 multisig address
 * @param addamount      — How much THIS user contributes
 * @param total          — Total channel capacity (both users combined)
 * @param tokenid        — Token being used (0x00 for Minima)
 * @param callback       — Returns hex-encoded transaction data, or "0x00" on failure
 */
function createFundingTxn(fundingaddress, addamount, total, tokenid, callback){

	var txid = randomString();

	var create = "txncreate id:"+txid+";"
		// Output: the full channel amount to the funding address
		+"txnoutput id:"+txid+" amount:"+total+" tokenid:"+tokenid+" address:"+fundingaddress+";"
		// Input: add this user's contribution (selects coins automatically)
		+"txnaddamount id:"+txid+" onlychange:true tokenid:"+tokenid+" amount:"+addamount+";"
		// Export the half-built transaction as hex data
		+"txnexport id:"+txid+";"
		// Clean up the temporary transaction from memory
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		MDS.log("createFundingTxn : "+JSON.stringify(fundresp));

		// Check if txnaddamount succeeded (user has enough funds)
		if(!fundresp[2].status){
			MDS.log("NOT ENOUGH FUNDS to create Channel!");
			callback("0x00");
		}else{
			// Return the exported hex transaction data
			callback(fundresp[3].response.data);
		}
	});
}

/**
 * Add funds to an existing funding transaction.
 *
 * When User 2 joins the channel, they import User 1's half-built funding
 * transaction and add their own contribution. If User 2's contribution
 * is zero (they're not putting money in), we skip this step.
 *
 * @param txndata   — Hex-encoded transaction from User 1
 * @param addamount — How much User 2 contributes
 * @param tokenid   — Token being used
 * @param callback  — Returns updated hex transaction data
 */
function addToFundingTxn(txndata, addamount, tokenid, callback){

	// If this user contributes nothing, pass through unchanged
	if(new Decimal(addamount).lessThanOrEqualTo(DECIMAL_ZERO)){
		callback(txndata);
		return;
	}

	var txid = randomString();

	var create = "txnimport id:"+txid+" data:"+txndata+";"
		+"txnaddamount id:"+txid+" onlychange:true tokenid:"+tokenid+" amount:"+addamount+";"
		+"txnexport id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp[2].response.data);
	});
}

/**
 * Create a cooperative close transaction that spends the FUNDING directly.
 *
 * This is the cleanest way to close a channel — both users agree on the
 * final balances and co-sign a single transaction that splits the funding.
 * No ELTOO mechanism needed. Fastest close (1 on-chain tx).
 *
 * The transaction is half-signed by the initiator, then sent to the
 * counterparty who co-signs and posts it.
 *
 * SECURITY: State port 200 is set to the channel's hashid so the
 * service.js payout tracker can identify which channel was closed.
 *
 * @param sqlrow  — Channel data from the SQL database
 * @param callback — Returns hex-encoded half-signed transaction
 */
function spendFundingTxn(sqlrow, callback){

	var txid = randomString();
	var cmdnum = 6; // Index of the txnexport response (adjusted if outputs skipped)

	// Determine which key to sign with (our key, not the counterparty's)
	var signkey = sqlrow.USER1PUBLICKEY;
	if(sqlrow.USERNUM != 1){
		signkey = sqlrow.USER2PUBLICKEY;
	}

	var tokenid = sqlrow.TOKENID;

	// Start building the transaction
	var create = "txncreate id:"+txid+";"
		// Input: the funding coin (floating = don't require specific coinid/MMR)
		+"txninput id:"+txid+" tokenid:"+tokenid+" amount:"+sqlrow.TOTALAMOUNT
			+" address:"+sqlrow.FUNDINGADDRESS+" floating:true;";

	// Output to User 1 (skip if their share is zero)
	if(!new Decimal(sqlrow.USER1AMOUNT).lessThanOrEqualTo(DECIMAL_ZERO)){
		create +="txnoutput id:"+txid+" tokenid:"+tokenid
			+" amount:"+sqlrow.USER1AMOUNT+" address:"+sqlrow.USER1ADDRESS+";";
	}else{
		cmdnum--;
	}

	// Output to User 2 (skip if their share is zero)
	if(!new Decimal(sqlrow.USER2AMOUNT).lessThanOrEqualTo(DECIMAL_ZERO)){
		create +="txnoutput id:"+txid+" tokenid:"+tokenid
			+" amount:"+sqlrow.USER2AMOUNT+" address:"+sqlrow.USER2ADDRESS+";";
	}else{
		cmdnum--;
	}

	// Set channel hashid for payout identification
	create +="txnstate id:"+txid+" port:200 value:"+sqlrow.HASHID+";"
		// Half-sign with our key
		+"txnsign id:"+txid+" publickey:"+signkey+";"
		+"txnexport id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp[cmdnum].response.data);
	});
}


/* =========================================================================
 * TRIGGER TRANSACTION
 * =========================================================================
 * The trigger is the FIRST step in a unilateral channel close.
 * It spends the funding coin and creates an ELTOO coin at sequence 0.
 * Both users pre-sign this at channel creation time.
 *
 * After posting the trigger, the counterparty has MIN_UPDATE_COINAGE blocks
 * to post a newer UPDATE (higher sequence). This is the core ELTOO mechanism
 * that ensures the latest agreed state always wins.
 * ========================================================================= */

/**
 * Create the trigger transaction.
 *
 * Spends: funding address → ELTOO address
 * Sets:   sequence = 0 (initial state)
 * Sets:   game phase = 0 (no active bet at channel start)
 *
 * Both users pre-sign this when the channel opens. Either can post it
 * later to begin unilateral close.
 *
 * @param amount         — Total channel amount
 * @param fundingaddress — Source: the 2-of-2 funding multisig
 * @param eltooaddress   — Destination: the ELTOO state channel address
 * @param tokenid        — Token being used
 * @param callback       — Returns hex-encoded transaction data
 */
function createTriggerTxn(amount, fundingaddress, eltooaddress, tokenid, callback){

	var txid = randomString();

	var create = "txncreate id:"+txid+";"
		// Input: spend the funding coin (floating = match by address, not coinid)
		+"txninput id:"+txid+" tokenid:"+tokenid+" amount:"+amount
			+" address:"+fundingaddress+" floating:true;"
		// Output: full amount to the ELTOO contract address
		// storestate:true — the state variables are stored on this coin
		+"txnoutput id:"+txid+" tokenid:"+tokenid+" storestate:true amount:"+amount
			+" address:"+eltooaddress+";"
		// Set initial sequence to 0
		+"txnstate id:"+txid+" port:101 value:0;"
		// CRITICAL: Set game phase to 0 (idle) — no active bet at channel start
		// If we don't set this, PREVSTATE(102) would be unset and could crash the Java VM
		+"txnstate id:"+txid+" port:102 value:0;"
		// Export and clean up
		+"txnexport id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp[5].response.data);
	});
}


/* =========================================================================
 * SETTLEMENT TRANSACTION
 * =========================================================================
 * A settlement transaction CLOSES the channel by splitting the ELTOO coin
 * to both users' payout addresses.
 *
 * It can only be posted when:
 *   - The ELTOO coin has aged enough (@COINAGE >= timeout)
 *   - The sequence matches (no newer update was posted)
 *   - Game phase is 0 (no active bet) — if phase=1, must use MAST
 *
 * Both users pre-sign settlement transactions at each state update.
 * The latest settlement (highest sequence) represents the agreed balance.
 *
 * GAME-AWARE EXTENSION:
 * Settlement transactions now carry all 16+ game state ports. Even during
 * normal (non-game) operation, we set phase=0 and zero out game ports.
 * This ensures the on-chain script never reads unset state ports.
 * ========================================================================= */

/**
 * Create a settlement transaction for the current channel state.
 *
 * This splits the ELTOO coin back to both users' addresses with the
 * current agreed balances. The output uses storestate:true because
 * the ELTOO script reads STATE from the spending transaction.
 *
 * SECURITY: All game state ports are explicitly set, even if zero.
 * Unset STATE ports crash the Java VM (learned from Wager V2 incident).
 *
 * @param hashid       — Channel identifier
 * @param sequence     — Current sequence number
 * @param eltooaddress — The ELTOO contract address to spend from
 * @param eltooamount  — Total amount in the ELTOO coin
 * @param user1amount  — User 1's share of the split
 * @param user1address — User 1's payout address (from channel creation)
 * @param user2amount  — User 2's share of the split
 * @param user2address — User 2's payout address (from channel creation)
 * @param tokenid      — Token being used
 * @param gamestate    — Game state object {phase, betamt, range, playercommit,
 *                        housecommit, pick, bettor, user1pubkey, user2pubkey,
 *                        prebetamt1, prebetamt2} — or null for non-game settle
 * @param callback     — Returns hex-encoded transaction data
 */
function createSettlementTxn(hashid, sequence, eltooaddress, eltooamount,
	user1amount, user1address, user2amount, user2address, tokenid, gamestate, callback){

	var txid = randomString();
	var cmdnum = 7; // Will be adjusted if we skip zero-amount outputs

	var create =
		"txncreate id:"+txid+";"
		// Input: the ELTOO coin (floating = match by address)
		+"txninput id:"+txid+" amount:"+eltooamount+" tokenid:"+tokenid
			+" address:"+eltooaddress+" floating:true;";

	// Output to User 1 — skip if their share is zero
	if(!new Decimal(user1amount).lessThanOrEqualTo(DECIMAL_ZERO)){
		create +="txnoutput id:"+txid+" storestate:true amount:"+user1amount
			+" tokenid:"+tokenid+" address:"+user1address+";";
	}else{
		cmdnum--;
	}

	// Output to User 2 — skip if their share is zero
	if(!new Decimal(user2amount).lessThanOrEqualTo(DECIMAL_ZERO)){
		create +="txnoutput id:"+txid+" storestate:true amount:"+user2amount
			+" tokenid:"+tokenid+" address:"+user2address+";";
	}else{
		cmdnum--;
	}

	/* ---- Standard ELTOO state ports ---- */
	create +="txnstate id:"+txid+" port:100 value:TRUE;"   // This IS a settlement
		+"txnstate id:"+txid+" port:101 value:"+sequence+";" // Current sequence
		+"txnstate id:"+txid+" port:200 value:"+hashid+";";  // Channel ID for tracking

	/* ---- Game state ports ---- */
	// CRITICAL: Always set ALL ports the script might read, even to 0
	// Unset STATE crashes the Java VM (Wager V2 bug, lost 666 Minima)
	if(gamestate && gamestate.phase == 1){
		// Active game — store full game state for MAST dispute resolution
		// 12 additional txnstate commands (ports 102-112, 115, 116)
		create +="txnstate id:"+txid+" port:102 value:1;"                          // Phase: bet active
			+"txnstate id:"+txid+" port:103 value:"+gamestate.betamt+";"            // Bet amount
			+"txnstate id:"+txid+" port:104 value:"+gamestate.range+";"             // Game range
			+"txnstate id:"+txid+" port:105 value:"+gamestate.playercommit+";"      // Player's SHA3(secret)
			+"txnstate id:"+txid+" port:106 value:"+gamestate.housecommit+";"       // House's SHA3(secret)
			+"txnstate id:"+txid+" port:107 value:"+gamestate.pick+";"              // Player's chosen number
			+"txnstate id:"+txid+" port:108 value:"+gamestate.bettor+";"            // Who is the player (1 or 2)
			+"txnstate id:"+txid+" port:109 value:"+user1address+";"                // User 1 payout addr (LOCKED)
			+"txnstate id:"+txid+" port:110 value:"+user2address+";"                // User 2 payout addr (LOCKED)
			+"txnstate id:"+txid+" port:111 value:"+gamestate.prebetamt1+";"        // User 1 pre-bet balance
			+"txnstate id:"+txid+" port:112 value:"+gamestate.prebetamt2+";"        // User 2 pre-bet balance
			+"txnstate id:"+txid+" port:115 value:"+gamestate.user1pubkey+";"       // User 1 pubkey (for MAST SIGNEDBY)
			+"txnstate id:"+txid+" port:116 value:"+gamestate.user2pubkey+";";      // User 2 pubkey (for MAST SIGNEDBY)
		cmdnum += 13; // 13 extra txnstate commands: ports 102-112(11) + 115,116(2) = 13
	}else{
		// No active game — set phase=0 and zero out game ports
		// This is the normal case for channel opens, sends, and cooperative closes
		create +="txnstate id:"+txid+" port:102 value:0;";  // Phase: idle
		cmdnum += 1; // FIX: 1 extra txnstate command (port 102)
		// Ports 103-116 are only read by MAST branches when phase=1
		// They don't need to be set when phase=0 because the main script
		// returns TRUE without reading them. But we set 102 explicitly
		// because the main script DOES read PREVSTATE(102).
	}

	create +="txnexport id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp[cmdnum].response.data);
	});
}


/* =========================================================================
 * UPDATE TRANSACTION
 * =========================================================================
 * An update transaction replaces the ELTOO coin with a newer state
 * (higher sequence number). It does NOT close the channel — the full
 * amount stays at the ELTOO address.
 *
 * Updates are used during unilateral close: after posting the trigger,
 * either party can post their latest update to ensure the most recent
 * agreed balance is used for settlement.
 *
 * The ELTOO script allows updates when: settlement=FALSE AND seq > prev_seq
 * ========================================================================= */

/**
 * Create an update transaction.
 *
 * Spends: ELTOO address → same ELTOO address (with higher sequence)
 * The amount stays the same — no money leaves the channel.
 *
 * Game state ports are carried forward on updates just like settlements,
 * so that if the channel is closed mid-game, the MAST branches have
 * the correct game data to work with.
 *
 * @param sequence     — The new sequence number (must be > previous)
 * @param eltooaddress — The ELTOO contract address
 * @param eltooamount  — Total amount in the channel
 * @param tokenid      — Token being used
 * @param gamestate    — Game state object or null
 * @param callback     — Returns hex-encoded transaction data
 */
function createUpdateTxn(sequence, eltooaddress, eltooamount, tokenid, gamestate, callback){

	var txid = randomString();

	var create =
		"txncreate id:"+txid+";"
		// Input: the current ELTOO coin
		+"txninput id:"+txid+" tokenid:"+tokenid+" amount:"+eltooamount
			+" address:"+eltooaddress+" floating:true;"
		// Output: same amount back to the ELTOO address (channel stays open)
		+"txnoutput id:"+txid+" tokenid:"+tokenid+" amount:"+eltooamount
			+" storestate:true address:"+eltooaddress+";"
		// settlement=FALSE — this is an update, not a settlement
		+"txnstate id:"+txid+" port:100 value:FALSE;"
		// New sequence number (strictly greater than previous)
		+"txnstate id:"+txid+" port:101 value:"+sequence+";";

	/* ---- Game state ports (same logic as settlement) ---- */
	if(gamestate && gamestate.phase == 1){
		create +="txnstate id:"+txid+" port:102 value:1;"
			+"txnstate id:"+txid+" port:103 value:"+gamestate.betamt+";"
			+"txnstate id:"+txid+" port:104 value:"+gamestate.range+";"
			+"txnstate id:"+txid+" port:105 value:"+gamestate.playercommit+";"
			+"txnstate id:"+txid+" port:106 value:"+gamestate.housecommit+";"
			+"txnstate id:"+txid+" port:107 value:"+gamestate.pick+";"
			+"txnstate id:"+txid+" port:108 value:"+gamestate.bettor+";"
			+"txnstate id:"+txid+" port:109 value:"+gamestate.user1address+";"   // FIX: was user1addr, now consistent
			+"txnstate id:"+txid+" port:110 value:"+gamestate.user2address+";"  // FIX: was user2addr, now consistent
			+"txnstate id:"+txid+" port:111 value:"+gamestate.prebetamt1+";"
			+"txnstate id:"+txid+" port:112 value:"+gamestate.prebetamt2+";"
			+"txnstate id:"+txid+" port:115 value:"+gamestate.user1pubkey+";"
			+"txnstate id:"+txid+" port:116 value:"+gamestate.user2pubkey+";";
	}else{
		create +="txnstate id:"+txid+" port:102 value:0;";
	}

	create +="txnexport id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		// Response index: txncreate(0), txninput(1), txnoutput(2),
		// txnstate(3..N), txnexport(N+1), txndelete(N+2)
		// For phase=0: 3 txnstates → export at index 6
		// For phase=1: 15 txnstates → export at index 18
		var exportIdx = (gamestate && gamestate.phase == 1) ? 18 : 6;
		callback(fundresp[exportIdx].response.data);
	});
}


/* =========================================================================
 * COMBINED SETTLE + UPDATE FOR CHANNEL STATE CHANGES
 * =========================================================================
 * When money moves in the channel (a send, or a game resolution), we
 * create BOTH a new settlement and a new update at the next sequence.
 * Both are half-signed by the initiator and sent to the counterparty.
 *
 * This is the core of the ELTOO protocol:
 *   - The settlement defines the final balance split if the channel closes
 *   - The update allows posting the latest state during unilateral close
 *   - The counterparty co-signs both, stores them, and returns copies
 *   - Both parties now hold the latest fully-signed settle + update
 * ========================================================================= */

/**
 * Create new settlement and update transactions for a balance change.
 *
 * Called when one user sends funds to the other (normal Thunder send)
 * or when a game round resolves and the balance needs updating.
 *
 * Increments the sequence number by 1 and creates both transactions
 * at the new sequence. Half-signs with the sender's key.
 *
 * @param details  — {hashid, amount, touser (1 or 2)}
 * @param callback — Returns (settletxn_hex, updatetxn_hex)
 */
function newSettleUpdateTxn(details, callback){

	// Get the current channel state from the database
	sqlSelectChannel(details.hashid, function(sql){
		var sqlrow = sql.rows[0];

		// Calculate the new balance after this transfer
		var newvalues = {};
		if(details.touser == 1){
			newvalues = calculateNewValues(sqlrow, details.amount, 1);
		}else{
			newvalues = calculateNewValues(sqlrow, details.amount, 2);
		}

		// Increment the sequence number
		var newsequence = new Decimal(sqlrow.SEQUENCE).plus(1);

		// Create a new settlement at the new sequence with updated balances
		// gamestate = null → phase=0 (no active bet during normal sends)
		createSettlementTxn(
			sqlrow.HASHID, newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
			newvalues.useramount1.toString(), sqlrow.USER1ADDRESS,
			newvalues.useramount2.toString(), sqlrow.USER2ADDRESS,
			sqlrow.TOKENID, null, // null gamestate = phase 0
			function(settletxn){

				// Create a matching update at the same sequence
				createUpdateTxn(
					newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
					sqlrow.TOKENID, null,
					function(updatetxn){

						// Half-sign both with our key
						signTxn(settletxn, sqlrow.USERPUBLICKEY, function(newsettletxn){
							signTxn(updatetxn, sqlrow.USERPUBLICKEY, function(newupdatetxn){
								callback(newsettletxn, newupdatetxn);
							});
						});
					}
				);
			}
		);
	});
}

/**
 * Create new settlement and update transactions for a GAME BET.
 *
 * This is the "pessimistic commit" — the player's bet is DEDUCTED from
 * their balance before the game plays out. If the player loses and walks
 * away, the house already has the correct (winning) balance.
 *
 * Called when both parties agree to start a game round. The gamestate
 * object contains all the commit-reveal data needed for on-chain dispute.
 *
 * @param details   — {hashid, betamt, range, pick, bettor, playercommit, housecommit}
 * @param callback  — Returns (settletxn_hex, updatetxn_hex)
 */
function newGameBetTxn(details, callback){

	// Get the current channel state
	sqlSelectChannel(details.hashid, function(sql){
		var sqlrow = sql.rows[0];

		// The pessimistic balance: player's bet is deducted
		// If bettor=1 (user1 is the player): user1 loses betamt, user2 gains it
		// If bettor=2 (user2 is the player): user2 loses betamt, user1 gains it
		var betamt = new Decimal(details.betamt);
		var user1amt, user2amt;

		if(details.bettor == 1){
			user1amt = new Decimal(sqlrow.USER1AMOUNT).sub(betamt);
			user2amt = new Decimal(sqlrow.USER2AMOUNT).plus(betamt);
		}else{
			user1amt = new Decimal(sqlrow.USER1AMOUNT).plus(betamt);
			user2amt = new Decimal(sqlrow.USER2AMOUNT).sub(betamt);
		}

		// Build the full game state object for the state ports
		var gamestate = {
			phase:        1,                          // Bet is active
			betamt:       details.betamt,              // How much is wagered
			range:        details.range,               // 2=flip, 6=dice, 36=roulette
			playercommit: details.playercommit,        // SHA3(player_secret)
			housecommit:  details.housecommit,         // SHA3(house_secret)
			pick:         details.pick,                // Player's chosen number
			bettor:       details.bettor,              // Who is the player (1 or 2)
			user1pubkey:  sqlrow.USER1PUBLICKEY,        // For MAST SIGNEDBY
			user2pubkey:  sqlrow.USER2PUBLICKEY,        // For MAST SIGNEDBY
			user1address: sqlrow.USER1ADDRESS,          // For MAST VERIFYOUT (consistent name)
			user2address: sqlrow.USER2ADDRESS,          // For MAST VERIFYOUT (consistent name)
			prebetamt1:   sqlrow.USER1AMOUNT,           // Balance BEFORE the bet
			prebetamt2:   sqlrow.USER2AMOUNT            // Balance BEFORE the bet
		};

		// Increment sequence
		var newsequence = new Decimal(sqlrow.SEQUENCE).plus(1);

		// Create settlement with pessimistic (player-lost) balances and full game state
		createSettlementTxn(
			sqlrow.HASHID, newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
			user1amt.toString(), sqlrow.USER1ADDRESS,
			user2amt.toString(), sqlrow.USER2ADDRESS,
			sqlrow.TOKENID, gamestate,
			function(settletxn){

				// Create matching update with the same game state
				createUpdateTxn(
					newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
					sqlrow.TOKENID, gamestate,
					function(updatetxn){

						// Half-sign both
						signTxn(settletxn, sqlrow.USERPUBLICKEY, function(newsettletxn){
							signTxn(updatetxn, sqlrow.USERPUBLICKEY, function(newupdatetxn){
								callback(newsettletxn, newupdatetxn);
							});
						});
					}
				);
			}
		);
	});
}


/* =========================================================================
 * TRANSACTION SIGNING
 * =========================================================================
 * Signing workflow:
 *   1. Import the hex transaction data into a temporary transaction
 *   2. Sign with the specified public key
 *   3. Export the now-signed transaction as hex
 *   4. Delete the temporary transaction
 *
 * For the ELTOO contract, we sign with the user's specific public key
 * (not "auto") because the script uses MULTISIG with those exact keys.
 *
 * For the FUNDING, we use "auto" because any wallet key can sign.
 * ========================================================================= */

/**
 * Sign a transaction with a specific public key.
 *
 * @param txndata   — Hex-encoded transaction to sign
 * @param publickey — The public key to sign with, or "auto" for wallet keys
 * @param callback  — Returns the signed hex transaction data
 */
function signTxn(txndata, publickey, callback){

	var txid = randomString();

	var create = "txnimport id:"+txid+" data:"+txndata+";"
		+"txnsign id:"+txid+" publickey:"+publickey+";"
		+"txnexport id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp[2].response.data);
	});
}

/**
 * Sign the trigger and settlement transactions (but NOT the funding).
 *
 * Called during channel creation. The trigger and settlement use the
 * user's ELTOO key (stored in the contract). The funding uses "auto"
 * because it's a standard wallet spend.
 *
 * @param alldata   — {transactions: {triggertxn, settletxn, fundingtxn}, addresses: {...}}
 * @param publickey — The user's ELTOO public key
 * @param callback  — Returns alldata with signed trigger and settlement
 */
function signTriggerAndSettlement(alldata, publickey, callback){

	// Sign the trigger first
	signTxn(alldata.transactions.triggertxn, publickey, function(signedtrigger){
		// Then sign the settlement
		signTxn(alldata.transactions.settletxn, publickey, function(signedsettle){
			alldata.transactions.triggertxn = signedtrigger;
			alldata.transactions.settletxn  = signedsettle;
			callback(alldata);
		});
	});
}

/**
 * Sign ALL three transactions: funding, trigger, and settlement.
 *
 * Called by the second user during channel creation. They sign:
 *   - Funding with "auto" (standard wallet spend)
 *   - Trigger with their ELTOO key
 *   - Settlement with their ELTOO key
 *
 * @param alldata   — {transactions: {fundingtxn, triggertxn, settletxn}}
 * @param publickey — The user's ELTOO public key
 * @param callback  — Returns alldata with all three transactions signed
 */
function signAllTxn(alldata, publickey, callback){

	// Funding uses "auto" — it's a standard wallet input, not an ELTOO key
	signTxn(alldata.transactions.fundingtxn, "auto", function(signedfunding){
		signTxn(alldata.transactions.triggertxn, publickey, function(signedtrigger){
			signTxn(alldata.transactions.settletxn, publickey, function(signedsettle){
				alldata.transactions.fundingtxn = signedfunding;
				alldata.transactions.triggertxn = signedtrigger;
				alldata.transactions.settletxn  = signedsettle;
				callback(alldata);
			});
		});
	});
}


/* =========================================================================
 * SCRIPT & MMR HELPERS
 * =========================================================================
 * These prepare transactions for posting by adding script proofs and
 * MMR (Merkle Mountain Range) data that the network needs to validate.
 * ========================================================================= */

/**
 * Add scripts and MMR proofs to a transaction.
 *
 * This is called on the funding transaction before posting. It:
 *   1. Auto-discovers which scripts are needed (txnscript auto:true)
 *   2. Adds MMR proofs for the inputs (txnmmr)
 *
 * IMPORTANT: Do NOT combine scriptmmr:true on txninput with txnbasics
 * (causes duplicate MMR proof error — learned from Limit DEX debugging).
 *
 * @param txndata  — Hex-encoded transaction
 * @param callback — Returns transaction with scripts and MMR added
 */
function scriptsMMRTxn(txndata, callback){

	var txid = randomString();

	var create = "txnimport id:"+txid+" data:"+txndata+";"
		+"txnscript id:"+txid+" auto:true;"
		+"txnmmr id:"+txid+";"
		+"txnexport id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp[3].response.data);
	});
}

/**
 * Check if a transaction is valid (structure check, not on-chain validation).
 *
 * NOTE: txncheck CANNOT validate scripts that use @COINAGE or @BLKNUM
 * (they need block context). It also returns scripts:false for valid
 * SIGNEDBY scripts sometimes. Don't gate on txncheck for ELTOO scripts.
 *
 * @param txndata  — Hex-encoded transaction
 * @param callback — Returns the check result
 */
function checkTxn(txndata, callback){

	var txid = randomString();

	var create = "txnimport id:"+txid+" data:"+txndata+";"
		+"txncheck id:"+txid+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp[1]);
	});
}

/**
 * Post a transaction to the network.
 *
 * WARNING: txnpost returns status:true even for invalid transactions!
 * The tx gets broadcast but may be silently rejected by miners.
 * Always wait 2+ blocks and verify the coin state changed.
 *
 * @param txndata  — Hex-encoded transaction to post
 * @param auto     — "true" to auto-add scripts/MMR, "false" to skip
 * @param callback — Returns the post result (DO NOT trust status alone)
 */
function postTxn(txndata, auto, callback){

	var txid = randomString();

	var create = "txnimport id:"+txid+" data:"+txndata+";"
		+"txnpost id:"+txid+" auto:"+auto+";"
		+"txndelete id:"+txid+";";

	MDS.cmd(create, function(fundresp){
		callback(fundresp);
	});
}


/* =========================================================================
 * CHANNEL CREATION HELPERS
 * =========================================================================
 * These orchestrate the multi-step process of creating addresses and
 * initial transactions when a channel is first opened.
 * ========================================================================= */

/**
 * Create both addresses (funding + ELTOO) for a new channel.
 *
 * @param sqlrow   — Channel data from database (needs USER1PUBLICKEY, USER2PUBLICKEY, HASHID)
 * @param callback — Returns {fundingaddress: {script, address}, eltooaddress: {script, address}}
 */
function createDefaultAddresses(sqlrow, callback){

	// Use MIN_UPDATE_COINAGE as the ELTOO script's timeout
	var timeout = MIN_UPDATE_COINAGE;

	createFundingAddress(sqlrow.HASHID, sqlrow.USER1PUBLICKEY, sqlrow.USER2PUBLICKEY, function(fundingaddress){
		createELTOOAddress(sqlrow.HASHID, sqlrow.USER1PUBLICKEY, sqlrow.USER2PUBLICKEY, timeout, function(eltooaddress){
			var addressdata = {};
			addressdata.fundingaddress = fundingaddress;
			addressdata.eltooaddress   = eltooaddress;
			callback(addressdata);
		});
	});
}

/**
 * Create the initial transactions (funding, trigger, settlement) for a new channel.
 *
 * The first user creates all three. The second user independently recreates
 * them to verify they match (addresses, amounts, transaction IDs).
 *
 * @param sqlrow         — Channel data
 * @param fundingaddress — The funding multisig address
 * @param eltooaddress   — The ELTOO contract address
 * @param createfunding  — true if this user creates the funding (User 1), false for User 2
 * @param callback       — Returns {fundingtxn, triggertxn, settletxn}
 */
function createDefaultTransactions(sqlrow, fundingaddress, eltooaddress, createfunding, callback){

	if(createfunding){
		// User 1: create funding + trigger + settlement
		createFundingTxn(fundingaddress, sqlrow.USER1AMOUNT, sqlrow.TOTALAMOUNT, sqlrow.TOKENID, function(fundingtxn){
			createTriggerTxn(sqlrow.TOTALAMOUNT, fundingaddress, eltooaddress, sqlrow.TOKENID, function(triggertxn){
				// Initial settlement: phase=0, no game state
				createSettlementTxn(sqlrow.HASHID, 0, eltooaddress, sqlrow.TOTALAMOUNT,
					sqlrow.USER1AMOUNT, sqlrow.USER1ADDRESS,
					sqlrow.USER2AMOUNT, sqlrow.USER2ADDRESS,
					sqlrow.TOKENID, null, function(settletxn){

					var txndata = {};
					txndata.fundingtxn = fundingtxn;
					txndata.triggertxn = triggertxn;
					txndata.settletxn  = settletxn;
					callback(txndata);
				});
			});
		});
	}else{
		// User 2: create trigger + settlement only (funding comes from User 1)
		createTriggerTxn(sqlrow.TOTALAMOUNT, fundingaddress, eltooaddress, sqlrow.TOKENID, function(triggertxn){
			createSettlementTxn(sqlrow.HASHID, 0, eltooaddress, sqlrow.TOTALAMOUNT,
				sqlrow.USER1AMOUNT, sqlrow.USER1ADDRESS,
				sqlrow.USER2AMOUNT, sqlrow.USER2ADDRESS,
				sqlrow.TOKENID, null, function(settletxn){

				var txndata = {};
				txndata.triggertxn = triggertxn;
				txndata.settletxn  = settletxn;
				callback(txndata);
			});
		});
	}
}

/**
 * Create addresses AND initial transactions for a new channel.
 *
 * This is the main entry point for channel creation. It:
 *   1. Gets channel details from the database
 *   2. Creates both addresses (funding + ELTOO)
 *   3. Creates the initial transactions
 *   4. Packages everything together
 *
 * @param hashid        — Channel identifier
 * @param createfunding — true for User 1 (creates funding), false for User 2
 * @param callback      — Returns {addresses: {...}, transactions: {...}}
 */
function createDefaultTxnAndAddresses(hashid, createfunding, callback){

	sqlSelectChannel(hashid, function(sql){
		createDefaultAddresses(sql.rows[0], function(addressdata){
			createDefaultTransactions(sql.rows[0],
				addressdata.fundingaddress.address,
				addressdata.eltooaddress.address,
				createfunding, function(txndata){

				var alldata = {};
				alldata.addresses    = addressdata;
				alldata.transactions = txndata;
				callback(alldata);
			});
		});
	});
}

/**
 * Register both channel scripts so the node tracks coins at those addresses.
 *
 * @param alldata  — {addresses: {fundingaddress: {script}, eltooaddress: {script}}}
 * @param callback — Called when both scripts are tracked
 */
function addDefaultScripts(alldata, callback){

	MDS.cmd("newscript trackall:true script:\""+alldata.addresses.fundingaddress.script+"\"", function(sc1){
		MDS.cmd("newscript trackall:true script:\""+alldata.addresses.eltooaddress.script+"\"", function(sc2){
			if(callback){ callback(); }
		});
	});
}


/* =========================================================================
 * TRANSACTION INSPECTION
 * ========================================================================= */

/**
 * View the contents of a hex-encoded transaction (for debugging/verification).
 *
 * @param txndata  — Hex-encoded transaction
 * @param callback — Returns the parsed transaction JSON, or false if invalid
 */
function viewTXN(txndata, callback){
	if(!checkSafeHashID(txndata)){
		callback(false);
		return;
	}
	MDS.cmd("txnview data:"+txndata, function(fundresp){
		callback(fundresp.response);
	});
}

/**
 * Verify that the counterparty's transactions match ours.
 *
 * During channel creation, User 2 independently creates the same trigger
 * and settlement transactions. This function compares transaction IDs to
 * ensure both parties are working with identical transactions.
 *
 * If the addresses or transaction IDs don't match, the channel creation
 * is aborted — the counterparty may be trying to cheat.
 *
 * @param hashid   — Channel identifier
 * @param sentdata — Data received from the counterparty
 * @param mydata   — Data we created locally
 * @param callback — Returns true if everything matches, false if mismatch
 */
function checkDefaultTransactions(hashid, sentdata, mydata, callback){

	// First check: do the addresses match?
	if(sentdata.addresses.fundingaddress.address != mydata.addresses.fundingaddress.address ||
	   sentdata.addresses.eltooaddress.address   != mydata.addresses.eltooaddress.address){
		callback(false);
		return;
	}

	// Second check: do the transaction IDs match?
	viewTXN(mydata.transactions.triggertxn, function(mytriggertxnjson){
		viewTXN(mydata.transactions.settletxn, function(mysettletxnjson){
			viewTXN(sentdata.transactions.triggertxn, function(senttriggertxnjson){
				viewTXN(sentdata.transactions.settletxn, function(sentsettletxnjson){
					if(mytriggertxnjson.transaction.transactionid != senttriggertxnjson.transaction.transactionid ||
					   mysettletxnjson.transaction.transactionid  != sentsettletxnjson.transaction.transactionid){
						callback(false);
					}else{
						callback(true);
					}
				});
			});
		});
	});
}
