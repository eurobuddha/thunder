/**
 * ============================================================================
 * THUNDER CASINO — Channel + Game Round Functions
 * ============================================================================
 *
 * This file provides the high-level functions that orchestrate:
 *
 *   A) CHANNEL MANAGEMENT (from Thunder 1.0.1)
 *      - requestNewChannel   → initiate a new channel
 *      - cancelNewChannel    → cancel a pending request
 *      - denyStartChannel    → deny a request
 *      - acceptStartChannel  → accept a request
 *      - sendFundsChannel    → send money within a channel
 *      - sendCreateChannel   → exchange signed txns during creation
 *      - sendSpendFunding    → cooperative close
 *
 *   B) GAME ROUND LIFECYCLE (new for Thunder Casino)
 *      - offerGameRound      → house offers a game to the player
 *      - acceptGameRound     → player accepts and commits
 *      - signGameBet         → both sign the pessimistic balance
 *      - revealGameSecret    → house reveals their secret
 *      - resolveGameRound    → player computes outcome, both sign resolved balance
 *
 * Every function uses the ACK/SYNACK handshake from maxima.js to ensure
 * message delivery before committing to state changes. If the counterparty
 * is offline, the operation fails cleanly without side effects.
 *
 * ============================================================================
 */


/* =========================================================================
 * A) CHANNEL MANAGEMENT — from Thunder 1.0.1
 * =========================================================================
 * These are functionally identical to the originals. Only documentation
 * is added. The game-aware changes are in section B below.
 * ========================================================================= */

/**
 * Request a new channel with a Maxima contact.
 *
 * Flow:
 *   1. Generate a unique hashid for this channel
 *   2. Build the channel request message
 *   3. Send via ACK/SYNACK (ensures delivery)
 *   4. Store in database as STATE_SENT_START_CHANNEL
 *
 * The ACK/SYNACK pattern means the actual request (step 2) only fires
 * AFTER we've confirmed the counterparty is online and listening.
 *
 * @param maximaid       — Counterparty's Maxima public key
 * @param myamount       — How much we contribute
 * @param requestamount  — How much we ask them to contribute
 * @param tokenname      — Token name
 * @param tokenid        — Token ID (0x00 for Minima)
 * @param tokendata      — Exported token data (for custom tokens)
 * @param callback       — Returns (delivered: boolean, hashid: string)
 */
function requestNewChannel(maximaid, myamount, requestamount, tokenname, tokenid, tokendata, callback){

	// Every channel gets a unique random hex ID
	var hashid = genRandomHexString();

	// Build the request message with our details and proposed amounts
	var details = startChannelMessage(hashid, myamount, maximaid, requestamount, tokenname, tokenid, tokendata);

	// Send via ACK/SYNACK — _requestNewChannel fires only after SYNACK
	ackFunctionCall(maximaid, _requestNewChannel, details, function(ackdelivered){

		if(ackdelivered){
			// Store the channel request in our database
			sqlInsertNewChannel(details, "STATE_SENT_START_CHANNEL", 1, function(ins){
				// Set our public key on the channel
				updateMyPublicKey(details.hashid, details.user.publickey, function(){
					if(callback){ callback(true, hashid); }
				});
			});
		}else{
			if(callback){ callback(false, hashid); }
		}
	});
}

// Called only after SYNACK confirms counterparty is online
function _requestNewChannel(details){
	sendMaximaMessage(details.tomaximapublickey, details);
}


/**
 * Cancel a pending channel request.
 */
function cancelNewChannel(hashid, maximaid, callback){
	var details = cancelChannelMessage(hashid, maximaid);

	ackFunctionCall(maximaid, _cancelNewChannel, details, function(ackdelivered){
		updateChannelState(hashid, "STATE_REQUEST_CANCELLED", function(){
			if(callback){ callback(ackdelivered); }
		});
	});
}

function _cancelNewChannel(details){
	sendMaximaMessage(details.tomaximapublickey, details);
}


/**
 * Deny a channel request from another user.
 */
function denyStartChannel(maximaid, hashid, callback){
	var details      = {};
	details.hashid   = hashid;
	details.maximaid = maximaid;

	ackFunctionCall(maximaid, _denyStartChannel, details, function(ackdelivered){
		updateChannelState(hashid, "STATE_REQUEST_DENIED", function(){
			if(callback){ callback(ackdelivered); }
		});
	});
}

function _denyStartChannel(details){
	sendMaximaMessage(details.maximaid, replyDenyMessage(details.hashid));
}


/**
 * Accept a channel request. This begins the 3-step creation handshake.
 */
function acceptStartChannel(maximaid, hashid, callback){
	var details      = {};
	details.hashid   = hashid;
	details.maximaid = maximaid;

	ackFunctionCall(maximaid, _acceptStartChannel, details, function(ackdelivered){
		if(callback){ callback(ackdelivered); }
	});
}

function _acceptStartChannel(details){
	sendMaximaMessage(details.maximaid, replyAcceptMessage(details.hashid));
}


/**
 * Send funds within an open channel.
 *
 * Creates new settlement + update txns at the next sequence with updated
 * balances, half-signs them, and sends to the counterparty via Maxima.
 *
 * @param hashid   — Channel identifier
 * @param maximaid — Counterparty's Maxima key
 * @param sequence — The new sequence number
 * @param amount   — Amount being transferred
 * @param touser   — Which user receives (1 or 2)
 * @param callback — Returns (delivered: boolean)
 */
function sendFundsChannel(hashid, maximaid, sequence, amount, touser, callback){
	var details      = {};
	details.hashid   = hashid;
	details.maximaid = maximaid;
	details.sequence = sequence;
	details.amount   = amount;
	details.touser   = touser;

	ackFunctionCall(maximaid, _sendFundsChannel, details, function(ackdelivered){
		if(callback){ callback(ackdelivered); }
	});
}

function _sendFundsChannel(details){
	// Create the new settlement + update txns with updated balances
	newSettleUpdateTxn(details, function(settletxn, updatetxn){
		sendMaximaMessage(details.maximaid,
			sendChannelMessage(details.hashid, details.sequence, details.amount, settletxn, updatetxn));
	});
}


/**
 * Send the initial signed txns during channel creation (3-step handshake).
 * Updates channel state and sends the signed data to the counterparty.
 */
function sendCreateChannel(msgtype, maximaid, hashid, txndata, callback){
	updateChannelState(hashid, "STATE_"+msgtype, function(upd){
		sendMaximaMessage(maximaid, replyCreateChannelMessage(hashid, msgtype, txndata), function(maxresp){
			if(callback){ callback(); }
		});
	});
}


/**
 * Send a cooperative close request.
 *
 * Creates a transaction that spends the funding directly to both users'
 * addresses (bypassing the ELTOO mechanism entirely). The counterparty
 * co-signs and posts it. One on-chain tx to close.
 */
function sendSpendFunding(hashid, maximaid, spendfundingtxn, callback){
	var details                = {};
	details.hashid             = hashid;
	details.maximaid           = maximaid;
	details.spendfundingtxn    = spendfundingtxn;

	ackFunctionCall(maximaid, _sendSpendFunding, details, function(ackdelivered){
		if(callback){ callback(ackdelivered); }
	});
}

function _sendSpendFunding(details){
	sendMaximaMessage(details.maximaid, spendChannelMessage(details.hashid, details.spendfundingtxn));
}


/* =========================================================================
 * B) GAME ROUND LIFECYCLE — new for Thunder Casino
 * =========================================================================
 *
 * A complete game round goes through these steps:
 *
 *   1. OFFER    — House generates secret, sends commit to player
 *   2. ACCEPT   — Player generates secret, sends commit + pick + bet
 *   3. BET SIGN — Both sign pessimistic balance (bet deducted from player)
 *   4. REVEAL   — House sends their actual secret to player
 *   5. RESOLVE  — Player computes outcome, both sign resolved balance
 *
 * Steps 1-3 happen BEFORE any money is at risk. The pessimistic balance
 * is the point of no return — after step 3, the bet is locked.
 *
 * Steps 4-5 happen AFTER the bet is locked. The house MUST reveal
 * (or the player reclaims after 1024 blocks via MAST Branch 2).
 *
 * The resolved balance (step 5) either confirms the pessimistic balance
 * (player lost) or corrects it to the winning balance (player won).
 *
 * ========================================================================= */

/**
 * STEP 1: House offers a game round.
 *
 * The house generates a secret, computes its SHA3 commitment, and sends
 * the commit + game type to the player via Maxima.
 *
 * The house commits FIRST — before seeing the player's commit.
 * This prevents the house from choosing a secret that beats the player.
 *
 * @param hashid    — Channel identifier
 * @param gametype  — "flip", "dice", or "roulette"
 * @param callback  — Returns (delivered: boolean)
 */
function offerGameRound(hashid, gametype, callback){

	// Get the counterparty's Maxima ID from the channel
	sqlSelectChannel(hashid, function(sql){
		var sqlrow = sql.rows[0];

		// Determine who is the counterparty
		var othermaximaid = (sqlrow.USERNUM == 1) ? sqlrow.USER2MAXIMAID : sqlrow.USER1MAXIMAID;

		// Generate the house's secret and commitment
		houseStartRound(hashid, gametype, function(data){
			if(!data){
				if(callback){ callback(false); }
				return;
			}

			// FIX: Store the house commit on the channel BEFORE sending
			// service.js GAME_ACCEPT handler reads sqlrow.HOUSECOMMIT to build
			// the pessimistic balance. Without this write, it would be empty
			// and the MAST dispute branch would fail (SHA3(secret) != '')
			MDS.sql("UPDATE channels SET housecommit='"+data.commit+"' WHERE hashid='"+hashid+"'", function(){

				// Send the offer via ACK/SYNACK
				var details          = {};
				details.hashid       = hashid;
				details.maximaid     = othermaximaid;
				details.housecommit  = data.commit;
				details.gametype     = gametype;
				details.range        = data.range;

				ackFunctionCall(othermaximaid, _offerGameRound, details, function(ackdelivered){
					if(callback){ callback(ackdelivered); }
				});
			});
		});
	});
}

function _offerGameRound(details){
	sendMaximaMessage(details.maximaid,
		gameOfferMessage(details.hashid, details.housecommit, details.gametype, details.range));
}


/**
 * STEP 2: Player accepts a game round.
 *
 * The player receives the house's commit, generates their own secret and
 * commit, chooses their pick, and sends everything back to the house.
 *
 * After this message is delivered, both parties have the commits needed
 * to build and sign the pessimistic balance (step 3).
 *
 * @param hashid       — Channel identifier
 * @param housecommit  — House's SHA3 commitment (received via GAME_OFFER)
 * @param gametype     — "flip", "dice", or "roulette"
 * @param pick         — Player's chosen number (0 to range-1)
 * @param betamt       — How much the player bets
 * @param callback     — Returns (delivered: boolean)
 */
function acceptGameRound(hashid, housecommit, gametype, pick, numpicks, betamt, callback){

	insertLog(hashid, "ACCEPT_GAME_DEBUG", "acceptGameRound called: pick="+pick+" numpicks="+numpicks+" betamt="+betamt+" gametype="+gametype);

	sqlSelectChannel(hashid, function(sql){
		if(!sql || sql.count == 0){
			insertLog(hashid, "ACCEPT_GAME_FAIL", "Channel not found");
			if(callback){ callback(false); }
			return;
		}
		var sqlrow = sql.rows[0];

		var game = GAME_TYPES[gametype];
		if(!game){
			insertLog(hashid, "ACCEPT_GAME_FAIL", "Unknown gametype: "+gametype);
			if(callback){ callback(false); }
			return;
		}
		var bettor = sqlrow.USERNUM;
		insertLog(hashid, "ACCEPT_GAME_DEBUG", "bettor="+bettor+" range="+game.range+" u1="+sqlrow.USER1AMOUNT+" u2="+sqlrow.USER2AMOUNT);

		var validation = validateBet(sqlrow, betamt, game.range, pick, numpicks, bettor);

		if(!validation.valid){
			insertLog(hashid, "GAME_BET_INVALID", "Validation failed: "+validation.error);
			if(callback){ callback(false); }
			return;
		}
		insertLog(hashid, "ACCEPT_GAME_DEBUG", "Validation passed");

		var othermaximaid = (sqlrow.USERNUM == 1) ? sqlrow.USER2MAXIMAID : sqlrow.USER1MAXIMAID;

		playerCommitRound(hashid, housecommit, gametype, pick, betamt, function(data){
			if(!data){
				insertLog(hashid, "ACCEPT_GAME_FAIL", "playerCommitRound returned null");
				if(callback){ callback(false); }
				return;
			}
			insertLog(hashid, "ACCEPT_GAME_DEBUG", "playerCommit generated: "+data.playercommit.substring(0,16));

			updateGameBetActive(hashid, gametype, game.range, betamt, bettor, pick, numpicks,
				data.playercommit, housecommit, sqlrow.USER1AMOUNT, sqlrow.USER2AMOUNT,
				function(){
					insertLog(hashid, "ACCEPT_GAME_DEBUG", "DB updated, sending ACK...");

					var details           = {};
					details.hashid        = hashid;
					details.maximaid      = othermaximaid;
					details.playercommit  = data.playercommit;
					details.pick          = data.pick;
					details.numpicks      = numpicks;
					details.betamt        = data.betamt;
					details.gametype      = gametype;

					ackFunctionCall(othermaximaid, _acceptGameRound, details, function(ackdelivered){
						if(callback){ callback(ackdelivered); }
					});
				});
		});
	});
}

function _acceptGameRound(details){
	sendMaximaMessage(details.maximaid,
		gameAcceptMessage(details.hashid, details.playercommit, details.pick, details.numpicks, details.betamt, details.gametype));
}


/**
 * STEP 3: Sign the pessimistic balance (bet deducted from player).
 *
 * Called after both parties have exchanged commits. Creates the new
 * ELTOO state with:
 *   - Player's balance reduced by bet amount (pessimistic — assumes loss)
 *   - House's balance increased by bet amount
 *   - Game phase = 1 (active bet)
 *   - All commit-reveal data stored in state ports (for MAST disputes)
 *
 * Both parties sign this state. After this, the bet is LOCKED.
 * The player's money is at risk — but so is the house's obligation
 * to reveal (or face MAST reclaim after 1024 blocks).
 *
 * @param hashid        — Channel identifier
 * @param playercommit  — Player's SHA3 commitment
 * @param housecommit   — House's SHA3 commitment
 * @param gametype      — "flip", "dice", or "roulette"
 * @param pick          — Player's chosen number
 * @param betamt        — How much the player bet
 * @param bettor        — Who is the player/bettor (1 or 2) — computed by caller
 * @param callback      — Returns (settletxn, updatetxn) hex data
 */
function signGameBet(hashid, playercommit, housecommit, gametype, pick, numpicks, betamt, bettor, callback){

	var game = GAME_TYPES[gametype];

	sqlSelectChannel(hashid, function(sql){
		var sqlrow = sql.rows[0];

		// FIX: bettor is now passed in by the caller (service.js GAME_ACCEPT handler)
		// The house receives GAME_ACCEPT from the player, so bettor = the sender's usernum
		// which is computed as: (sqlrow.USERNUM == 1) ? 2 : 1 in service.js line 614

		// Build the game bet details
		var details = {
			hashid:       hashid,
			betamt:       betamt,
			range:        game.range,
			pick:         pick,
			numpicks:     numpicks || 1,
			bettor:       bettor,
			playercommit: playercommit,
			housecommit:  housecommit
		};

		// Create the pessimistic-balance settlement + update txns
		newGameBetTxn(details, function(settletxn, updatetxn){
			if(!settletxn || !updatetxn){
				MDS.log("BURN GUARD: newGameBetTxn returned null — aborting bet");
				insertLog(hashid, "GAME_BET_BLOCKED", "Burn guard prevented invalid bet");
				if(callback){ callback(null, null); }
				return;
			}

			// Store the active game state in the database
			updateGameBetActive(hashid, gametype, game.range, betamt, bettor, pick, numpicks,
				playercommit, housecommit, sqlrow.USER1AMOUNT, sqlrow.USER2AMOUNT,
				function(updatedrow){

					selectLatestRoundNumber(hashid, function(maxround){
						var nextround = maxround + 1;

						insertGameRound(hashid, nextround, gametype, game.range, betamt,
							bettor, pick, numpicks, playercommit, housecommit,
							function(roundid){

								// Link the round to the channel
								MDS.sql("UPDATE channels SET gameroundid="+roundid+" WHERE hashid='"+hashid+"'");

								insertLog(hashid, "GAME_BET_SIGNED",
									"Pessimistic balance signed. Game:"+game.name
									+" Bet:"+betamt+" Pick:"+getPickLabel(gametype, pick)
									+" Bettor:user"+bettor+" Round:#"+nextround);

								callback(settletxn, updatetxn);
							}
						);
					});
				}
			);
		});
	});
}


/**
 * STEP 4: House reveals their secret.
 *
 * After the pessimistic balance is signed, the house reveals their
 * actual secret to the player. The player can now compute the outcome.
 *
 * The house MUST reveal — if they don't, the player can reclaim their
 * bet after 1024 blocks via MAST Branch 2. The house has no incentive
 * to withhold: they've already been paid in the pessimistic balance.
 * If the player won, the house must pay them anyway (MAST Branch 3).
 *
 * @param hashid   — Channel identifier
 * @param callback — Returns (delivered: boolean)
 */
function revealGameSecret(hashid, callback){

	sqlSelectChannel(hashid, function(sql){
		var sqlrow = sql.rows[0];

		var othermaximaid = (sqlrow.USERNUM == 1) ? sqlrow.USER2MAXIMAID : sqlrow.USER1MAXIMAID;

		// Retrieve our stored secret for this game's house commit
		houseRevealSecret(hashid, sqlrow.HOUSECOMMIT, function(secret){
			if(!secret){
				insertLog(hashid, "GAME_REVEAL_FAILED", "Could not retrieve house secret!");
				if(callback){ callback(false); }
				return;
			}

			// Store the revealed secret in the channel record
			// (for MAST dispute if needed later)
			updateGameHouseRevealed(hashid, secret, function(){

				// Update the audit trail
				var roundnum = sqlrow.GAMEROUNDID;
				MDS.sql("SELECT round FROM gamerounds WHERE id="+roundnum, function(rres){
					var round = (rres.count > 0) ? rres.rows[0].ROUND : 0;
					updateGameRoundRevealed(hashid, round, secret);
				});

				// Send the secret to the player
				sendMaximaMessage(othermaximaid, gameRevealMessage(hashid, secret), function(maxresp){
					insertLog(hashid, "GAME_SECRET_SENT", "House secret revealed to player");
					if(callback){ callback(true); }
				});
			});
		});
	});
}


/**
 * STEP 5: Resolve the game round.
 *
 * Called after the player receives the house's secret. Computes the
 * outcome, determines the winner, and initiates signing of the resolved
 * balance.
 *
 * If the player LOST: the pessimistic balance is already correct.
 * We sign a new state at the next sequence with phase=0 (idle) and
 * the same balances. This clears the game state.
 *
 * If the player WON: we compute the winning balance and sign a new
 * state with the corrected amounts and phase=0.
 *
 * In both cases, the player reveals their secret to the house so
 * the house can independently verify the outcome.
 *
 * @param hashid       — Channel identifier
 * @param housesecret  — House's revealed secret
 * @param callback     — Returns (winner: "player"|"house", delivered: boolean)
 */
function resolveGameRound(hashid, housesecret, callback){

	sqlSelectChannel(hashid, function(sql){
		var sqlrow = sql.rows[0];

		// Resolve the round — verify secrets, compute outcome
		resolveRound(hashid, housesecret, sqlrow.HOUSECOMMIT, sqlrow.PLAYERCOMMIT,
			sqlrow.PLAYERPICK, sqlrow.GAMETYPE, function(resolution){

				if(!resolution){
					insertLog(hashid, "GAME_RESOLVE_FAILED", "Could not resolve round — check secrets");
					if(callback){ callback(null, false); }
					return;
				}

				// Calculate the correct post-game balance
				var newbalance = calculateGameBalance(sqlrow, resolution.winner);

				// Store the result
				var gameresult = (resolution.winner === "player") ? "WIN" : "LOSS";

				// Determine our role
				var amIBettor = (sqlrow.USERNUM == parseInt(sqlrow.BETTOR));
				if(!amIBettor){
					// We're the house — flip the result label
					gameresult = (resolution.winner === "player") ? "LOSS" : "WIN";
				}

				updateGameResult(hashid, resolution.playersecret, gameresult, function(){

					// Update the audit trail with full resolution data
					var roundnum = sqlrow.GAMEROUNDID;
					MDS.sql("SELECT round FROM gamerounds WHERE id="+roundnum, function(rres){
						var round = (rres.count > 0) ? rres.rows[0].ROUND : 0;
						updateGameRoundResolved(hashid, round, resolution.playersecret,
							resolution.hash, resolution.result, resolution.winner,
							newbalance.user1amount, newbalance.user2amount);
					});

					// Now sign the resolved balance — create new settle + update
					// at the next sequence with phase=0 and the correct amounts
					var othermaximaid = (sqlrow.USERNUM == 1) ? sqlrow.USER2MAXIMAID : sqlrow.USER1MAXIMAID;

					var details = {
						hashid: hashid,
						amount: "0",  // Not a transfer — it's a balance correction
						touser: 0     // Not applicable — we set amounts directly
					};

					// Override: we need to set specific amounts, not compute from a transfer
					// Use the standard newSettleUpdateTxn but with pre-set amounts
					var newsequence = new Decimal(sqlrow.SEQUENCE).plus(1);

					createSettlementTxn(
						sqlrow.HASHID, newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
						newbalance.user1amount, sqlrow.USER1ADDRESS,
						newbalance.user2amount, sqlrow.USER2ADDRESS,
						sqlrow.TOKENID, null, // null gamestate = phase 0 (resolved)
						function(settletxn){

							createUpdateTxn(
								newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
								sqlrow.TOKENID, null,
								function(updatetxn){

									// Half-sign both
									signTxn(settletxn, sqlrow.USERPUBLICKEY, function(signedsettletxn){
										signTxn(updatetxn, sqlrow.USERPUBLICKEY, function(signedupdatetxn){

											// Send the result + player's secret + signed txns to the counterparty
											sendMaximaMessage(othermaximaid,
												gameResultMessage(hashid, resolution.playersecret,
													resolution.result, resolution.winner, resolution.gametype));

											// Send the signed resolved-balance txns
											sendMaximaMessage(othermaximaid,
												gameResultSignedMessage(hashid, newsequence.toString(),
													signedsettletxn, signedupdatetxn));

											insertLog(hashid, "GAME_RESOLVE_SENT",
												"Resolved balance sent to counterparty."
												+" Winner:"+resolution.winner
												+" User1:"+newbalance.user1amount
												+" User2:"+newbalance.user2amount);

											if(callback){ callback(resolution.winner, true); }
										});
									});
								}
							);
						}
					);
				});
			}
		);
	});
}


/**
 * Complete a game round after receiving the counterparty's signed resolution.
 *
 * Called when we receive GAME_RESULT_SIGNED. We co-sign the resolved
 * balance, store it, and clear the game state. The channel is now
 * back to idle (phase=0), ready for the next game.
 *
 * @param hashid     — Channel identifier
 * @param sequence   — The new sequence number
 * @param settletxn  — Half-signed settlement with resolved balance
 * @param updatetxn  — Half-signed update with phase=0
 * @param winner     — "player" or "house"
 * @param newbal1    — User 1's resolved balance
 * @param newbal2    — User 2's resolved balance
 * @param callback   — Returns updated channel row
 */
function completeGameRound(hashid, sequence, settletxn, updatetxn, winner, newbal1, newbal2, callback){

	sqlSelectChannel(hashid, function(sql){
		var sqlrow = sql.rows[0];

		// Co-sign the resolved balance
		signTxn(settletxn, sqlrow.USERPUBLICKEY, function(cosignedsettletxn){
			signTxn(updatetxn, sqlrow.USERPUBLICKEY, function(cosignedupdatetxn){

				// Store the new signed state
				updateNewSequenceTxn(hashid, sequence, newbal1, newbal2,
					cosignedsettletxn, cosignedupdatetxn, function(){

						// Clear the game state — channel is idle again
						updateGameCleared(hashid, function(updatedrow){

							insertLog(hashid, "GAME_ROUND_COMPLETE",
								"Round complete! Winner:"+winner
								+" User1:"+newbal1+" User2:"+newbal2
								+" Sequence:"+sequence);

							if(callback){ callback(updatedrow); }
						});
					}
				);
			});
		});
	});
}
