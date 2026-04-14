/**
 * ============================================================================
 * THUNDER CASINO — Maxima Message Definitions
 * ============================================================================
 *
 * All communication between channel parties happens via Maxima messages.
 * Each message is a JSON object with a `type` field that identifies what
 * kind of message it is.
 *
 * This file defines the MESSAGE CONSTRUCTORS — functions that build the
 * JSON payloads. The actual sending happens via maxima.js (sendMaximaMessage).
 *
 * MESSAGE TYPES — CHANNEL MANAGEMENT (from Thunder 1.0.1):
 *   ACK_MESSAGE           — TCP-like handshake: "are you there?"
 *   SYNACK_MESSAGE        — Reply: "yes, I received your ACK"
 *   REQUEST_NEW_CHANNEL   — Ask to open a new channel
 *   CANCEL_NEW_CHANNEL    — Cancel a pending channel request
 *   REQUEST_DENIED        — Deny a channel request
 *   REQUEST_ACCEPTED      — Accept a channel request
 *   CHANNEL_CREATE_1/2/3  — 3-phase channel creation handshake
 *   SPEND_CHANNEL         — Cooperative close
 *   SEND_FUNDS            — Send money within a channel
 *   REPLY_SEND_FUNDS      — Confirm receipt of funds
 *
 * MESSAGE TYPES — CASINO GAMES (new):
 *   GAME_OFFER             — House offers a game round (sends their commit)
 *   GAME_ACCEPT            — Player accepts and commits (sends their commit + pick + bet)
 *   GAME_BET_SIGNED        — Exchange of signed pessimistic-balance ELTOO state
 *   GAME_REVEAL            — House reveals their secret
 *   GAME_RESULT            — Player reports the outcome
 *   GAME_RESULT_SIGNED     — Exchange of signed resolved-balance ELTOO state
 *   GAME_ABANDONED         — Game round abandoned (timeout, error, etc.)
 *
 * ============================================================================
 */


/* =========================================================================
 * CHANNEL MANAGEMENT MESSAGES (from Thunder 1.0.1, unchanged)
 * ========================================================================= */

/**
 * ACK message — first step of the TCP-like handshake.
 * Sent before any critical operation to verify the counterparty is online.
 * The randid is used to match the ACK with its SYNACK response.
 */
function ackMessage(){
	var msg      = {};
	msg.type     = "ACK_MESSAGE";
	msg.randid   = genRandomHexString();
	return msg;
}

/**
 * SYNACK message — reply to an ACK, proving we received it.
 * Echoes back the same randid so the sender can match it.
 */
function synackMessage(ackmessage){
	var msg     = {};
	msg.type    = "SYNACK_MESSAGE";
	msg.randid  = ackmessage.randid;
	return msg;
}

/**
 * Simple message with just a type and channel hashid.
 * Used for confirmations and status updates.
 */
function replySimpleMessage(hashid, msgtype){
	var msg      = {};
	msg.type     = msgtype;
	msg.hashid   = hashid;
	return msg;
}

/**
 * Request to open a new channel.
 *
 * Sent by User 1 to User 2 proposing a channel with specified amounts.
 * Contains: both amounts, token details, and User 1's identity.
 *
 * @param hashid              — Unique channel ID (randomly generated)
 * @param myamount            — How much User 1 will contribute
 * @param tomaximapublickey   — User 2's Maxima public key
 * @param requestamount       — How much User 2 should contribute
 * @param tokenname           — Name of the token being used
 * @param tokenid             — Token identifier (0x00 for Minima)
 * @param tokendata           — Exported token data (for custom tokens)
 */
function startChannelMessage(hashid, myamount, tomaximapublickey, requestamount, tokenname, tokenid, tokendata){
	var msg = {};
	msg.type              = "REQUEST_NEW_CHANNEL";
	msg.hashid            = hashid;
	msg.user              = getUserDetails();        // Our name, maxima ID, address, pubkey
	msg.tokenname         = tokenname;
	msg.tokenid           = tokenid;
	msg.tokendata         = tokendata;
	msg.tomaximapublickey = tomaximapublickey;
	msg.useramount        = new Decimal(myamount).toString();
	msg.requestamount     = new Decimal(requestamount).toString();
	msg.totalamount       = new Decimal(requestamount).add(new Decimal(myamount)).toString();
	return msg;
}

/**
 * Cancel a pending channel request (before the other party accepts).
 */
function cancelChannelMessage(hashid, tomaximapublickey){
	var msg = {};
	msg.type              = "CANCEL_NEW_CHANNEL";
	msg.hashid            = hashid;
	msg.tomaximapublickey = tomaximapublickey;
	return msg;
}

/**
 * Deny a channel request.
 */
function replyDenyMessage(hashid){
	return replySimpleMessage(hashid, "REQUEST_DENIED");
}

/**
 * Accept a channel request.
 * Sends back User 2's identity details.
 */
function replyAcceptMessage(hashid){
	var msg      = {};
	msg.type     = "REQUEST_ACCEPTED";
	msg.hashid   = hashid;
	msg.user     = getUserDetails();
	return msg;
}

/**
 * Send channel creation data (addresses + half-signed transactions).
 * Used in the 3-step channel creation handshake (CHANNEL_CREATE_1/2/3).
 *
 * @param hashid  — Channel identifier
 * @param msgtype — "CHANNEL_CREATE_1", "CHANNEL_CREATE_2", or "CHANNEL_CREATE_3"
 * @param txndata — {addresses: {...}, transactions: {...}}
 */
function replyCreateChannelMessage(hashid, msgtype, txndata){
	var msg      = {};
	msg.type     = msgtype;
	msg.hashid   = hashid;
	msg.txndata  = txndata;
	return msg;
}

/**
 * Final channel creation message with fully signed transactions.
 * (Legacy from Thunder 1.0.1 — may not be needed in new flow)
 */
function finishChannelMessage(hashid, fundingtxn, triggertxn, settletxn){
	var msg           = {};
	msg.type          = "FINISH_START_CHANNEL";
	msg.hashid        = hashid;
	msg.fundingtxn    = fundingtxn;
	msg.triggertxn    = triggertxn;
	msg.settletxn     = settletxn;
	return msg;
}

/**
 * Cooperative close — spend the funding directly back to both users.
 * Contains a half-signed spending transaction. The counterparty co-signs
 * and posts it. Channel closes in 1 on-chain tx.
 */
function spendChannelMessage(hashid, spendfundingtxn){
	var msg              = {};
	msg.type             = "SPEND_CHANNEL";
	msg.hashid           = hashid;
	msg.spendfundingtxn  = spendfundingtxn;
	return msg;
}

/**
 * Send funds within a channel (standard Thunder transfer).
 * Contains half-signed settlement and update at the new sequence.
 */
function sendChannelMessage(hashid, sequence, amount, settletxn, updatetxn){
	var msg          = {};
	msg.type         = "SEND_FUNDS";
	msg.hashid       = hashid;
	msg.sequence     = sequence;
	msg.amount       = amount;
	msg.settletxn    = settletxn;
	msg.updatetxn    = updatetxn;
	return msg;
}

/**
 * Reply to a SEND_FUNDS with co-signed settlement and update.
 */
function replySendChannelMessage(hashid, sequence, amount, settletxn, updatetxn){
	var msg          = {};
	msg.type         = "REPLY_SEND_FUNDS";
	msg.hashid       = hashid;
	msg.sequence     = sequence;
	msg.amount       = amount;
	msg.settletxn    = settletxn;
	msg.updatetxn    = updatetxn;
	return msg;
}


/* =========================================================================
 * CASINO GAME MESSAGES (new)
 * =========================================================================
 *
 * These messages implement the commit-reveal game protocol:
 *
 *   Step 1: House → Player:  GAME_OFFER    (house commit + game type)
 *   Step 2: Player → House:  GAME_ACCEPT   (player commit + pick + bet amount)
 *   Step 3: Both exchange:   GAME_BET_SIGNED (signed pessimistic ELTOO state)
 *   Step 4: House → Player:  GAME_REVEAL   (house secret)
 *   Step 5: Player → House:  GAME_RESULT   (outcome + player secret)
 *   Step 6: Both exchange:   GAME_RESULT_SIGNED (signed resolved ELTOO state)
 *
 * All messages include the channel hashid for routing.
 * All game-specific data is validated by the recipient before acting.
 * ========================================================================= */

/**
 * GAME_REQUEST — Player requests a game round.
 *
 * The player has chosen a game type, picked a number, and set a bet.
 * They send this to the counterparty who will auto-house the round.
 * The counterparty's service.js generates a house secret, commits,
 * and sends back GAME_OFFER with the house commit.
 *
 * This is the FIRST message in the game flow — initiated by the player.
 *
 * @param hashid    — Channel identifier
 * @param gametype  — "flip", "dice", or "roulette"
 * @param pick      — Player's chosen number (0 to range-1)
 * @param betamt    — How much the player is wagering
 */
function gameRequestMessage(hashid, gametype, pick, betamt){
	var msg          = {};
	msg.type         = "GAME_REQUEST";
	msg.hashid       = hashid;
	msg.gametype     = gametype;
	msg.pick         = pick;
	msg.betamt       = betamt;
	return msg;
}

/**
 * GAME_OFFER — House offers a game round.
 *
 * The house sends their SHA3 commitment and the game type.
 * The player responds with GAME_ACCEPT or ignores.
 *
 * SECURITY: The house commits BEFORE seeing the player's commit.
 * They cannot change their secret after seeing the player's choice.
 *
 * @param hashid      — Channel identifier
 * @param housecommit — SHA3(house_secret) — the commitment, NOT the secret
 * @param gametype    — "flip", "dice", or "roulette"
 * @param range       — Number of outcomes (2, 6, or 36) — redundant but explicit
 */
function gameOfferMessage(hashid, housecommit, gametype, range){
	var msg          = {};
	msg.type         = "GAME_OFFER";
	msg.hashid       = hashid;
	msg.housecommit  = housecommit;
	msg.gametype     = gametype;
	msg.range        = range;
	return msg;
}

/**
 * GAME_ACCEPT — Player accepts and commits to the game.
 *
 * The player sends their SHA3 commitment, their chosen pick, and
 * the bet amount. After this, both parties sign the pessimistic balance.
 *
 * SECURITY: The player's secret is hidden behind the commit hash.
 * The house cannot see the player's pick from the commit alone.
 * The pick IS visible (it's sent in cleartext), but that's fine —
 * the randomness comes from BOTH secrets combined, not the pick alone.
 *
 * @param hashid        — Channel identifier
 * @param playercommit  — SHA3(player_secret) — commitment, not secret
 * @param pick          — Player's chosen number (0 to range-1)
 * @param betamt        — How much the player is wagering
 * @param gametype      — "flip", "dice", or "roulette"
 */
function gameAcceptMessage(hashid, playercommit, pick, betamt, gametype){
	var msg           = {};
	msg.type          = "GAME_ACCEPT";
	msg.hashid        = hashid;
	msg.playercommit  = playercommit;
	msg.pick          = pick;
	msg.betamt        = betamt;
	msg.gametype      = gametype;
	return msg;
}

/**
 * GAME_BET_SIGNED — Exchange signed pessimistic-balance ELTOO state.
 *
 * After both parties commit, they need to sign the new ELTOO state that
 * reflects the pessimistic balance (player's bet deducted). This message
 * carries the half-signed settlement and update transactions.
 *
 * Both parties exchange these messages. Each half-signs, then the
 * recipient co-signs. After both have fully-signed copies, the game
 * state is locked in — the bet is on.
 *
 * @param hashid    — Channel identifier
 * @param sequence  — The new sequence number for this state
 * @param settletxn — Half-signed settlement transaction (hex)
 * @param updatetxn — Half-signed update transaction (hex)
 */
function gameBetSignedMessage(hashid, sequence, settletxn, updatetxn){
	var msg          = {};
	msg.type         = "GAME_BET_SIGNED";
	msg.hashid       = hashid;
	msg.sequence     = sequence;
	msg.settletxn    = settletxn;
	msg.updatetxn    = updatetxn;
	return msg;
}

/**
 * GAME_REVEAL — House reveals their secret to the player.
 *
 * After the pessimistic balance is signed, the house reveals.
 * The player can now compute the outcome. If they won, they reveal
 * their secret too (via GAME_RESULT). If they lost, they still
 * cooperate because the pessimistic balance is already correct.
 *
 * SECURITY: The house secret was committed BEFORE seeing the player's
 * commit. Revealing it now doesn't help the house cheat — the outcome
 * is deterministic from both secrets.
 *
 * @param hashid      — Channel identifier
 * @param housesecret — The house's actual secret (the preimage of housecommit)
 */
function gameRevealMessage(hashid, housesecret){
	var msg          = {};
	msg.type         = "GAME_REVEAL";
	msg.hashid       = hashid;
	msg.housesecret  = housesecret;
	return msg;
}

/**
 * GAME_RESULT — Player reports the outcome and reveals their secret.
 *
 * After computing the outcome, the player sends:
 *   - Their own secret (so the house can verify the outcome)
 *   - The computed result (for logging — the house will verify independently)
 *   - Who won
 *
 * The house verifies the player's secret against their commit,
 * independently computes the outcome, and confirms it matches.
 *
 * @param hashid        — Channel identifier
 * @param playersecret  — The player's actual secret (preimage of playercommit)
 * @param result        — The computed outcome (0 to range-1)
 * @param winner        — "player" or "house"
 * @param gametype      — Game type for context
 */
function gameResultMessage(hashid, playersecret, result, winner, gametype){
	var msg           = {};
	msg.type          = "GAME_RESULT";
	msg.hashid        = hashid;
	msg.playersecret  = playersecret;
	msg.result        = result;
	msg.winner        = winner;
	msg.gametype      = gametype;
	return msg;
}

/**
 * GAME_RESULT_SIGNED — Exchange signed resolved-balance ELTOO state.
 *
 * After both parties agree on the outcome, they sign the new ELTOO state
 * with the resolved balance (corrected from pessimistic if player won)
 * and game phase set back to 0 (idle).
 *
 * This is structurally identical to GAME_BET_SIGNED but represents
 * the resolved state rather than the pessimistic state.
 *
 * @param hashid    — Channel identifier
 * @param sequence  — The new sequence number
 * @param settletxn — Half-signed settlement with resolved balance
 * @param updatetxn — Half-signed update with phase=0
 */
function gameResultSignedMessage(hashid, sequence, settletxn, updatetxn){
	var msg          = {};
	msg.type         = "GAME_RESULT_SIGNED";
	msg.hashid       = hashid;
	msg.sequence     = sequence;
	msg.settletxn    = settletxn;
	msg.updatetxn    = updatetxn;
	return msg;
}

/**
 * GAME_ABANDONED — Game round abandoned.
 *
 * Sent when a game round cannot complete (timeout, error, mutual cancel).
 * No balance change occurs — the last agreed state remains.
 *
 * @param hashid — Channel identifier
 * @param reason — Human-readable reason for abandonment
 */
function gameAbandonedMessage(hashid, reason){
	var msg      = {};
	msg.type     = "GAME_ABANDONED";
	msg.hashid   = hashid;
	msg.reason   = reason;
	return msg;
}


/* =========================================================================
 * TNZEC ROUTING MESSAGES
 * ========================================================================= */

/** Hub → House: incoming game, be the house */
function houseRequestMessage(hashid, gametype, range, betamt){
	var msg      = {};
	msg.type     = "HOUSE_REQUEST";
	msg.hashid   = hashid;
	msg.gametype = gametype;
	msg.range    = range;
	msg.betamt   = betamt;
	return msg;
}

/** House → Hub: house's commit */
function houseOfferMessage(hashid, housecommit, gametype, range){
	var msg          = {};
	msg.type         = "HOUSE_OFFER";
	msg.hashid       = hashid;
	msg.housecommit  = housecommit;
	msg.gametype     = gametype;
	msg.range        = range;
	return msg;
}

/** Hub → House: player's commit + pick + bet (forwarded) */
function playerAcceptedMessage(hashid, playercommit, pick, betamt, gametype){
	var msg           = {};
	msg.type          = "PLAYER_ACCEPTED";
	msg.hashid        = hashid;
	msg.playercommit  = playercommit;
	msg.pick          = pick;
	msg.betamt        = betamt;
	msg.gametype      = gametype;
	return msg;
}

/** House → Hub: house's secret (hub forwards to player as GAME_REVEAL) */
function houseRevealMessage(hashid, housesecret){
	var msg          = {};
	msg.type         = "HOUSE_REVEAL";
	msg.hashid       = hashid;
	msg.housesecret  = housesecret;
	return msg;
}

/** Hub → All: network capacity broadcast */
function poolStatusMessage(online, totalCapacity, maxFlip, maxDice, maxRoulette){
	var msg             = {};
	msg.type            = "POOL_STATUS";
	msg.online          = online;
	msg.totalCapacity   = totalCapacity;
	msg.maxFlip         = maxFlip;
	msg.maxDice         = maxDice;
	msg.maxRoulette     = maxRoulette;
	return msg;
}
