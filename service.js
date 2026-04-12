/**
 * ============================================================================
 * THUNDER CASINO — Background Service
 * ============================================================================
 *
 * This runs persistently in the background and handles:
 *
 *   1. INITIALIZATION  — Create database, load identity
 *   2. NEWBLOCK        — Monitor ELTOO coins on-chain, trigger MAST disputes
 *   3. NEWCOIN         — Track funding/payout coins for channel state changes
 *   4. MAXIMA          — Process ALL incoming messages:
 *        a) Channel management (request, accept, create, close)
 *        b) Game protocol (offer, accept, bet-signed, reveal, result, result-signed)
 *
 * Every incoming Maxima message goes through the ACK/SYNACK handshake
 * (handled in index.html for frontend messages, here for backend processing).
 *
 * The service.js processes game messages automatically:
 *   - House auto-reveals after pessimistic balance is signed
 *   - Player auto-resolves after receiving the house's secret
 *   - MAST disputes auto-triggered when ELTOO coins appear on-chain
 *
 * SECURITY:
 *   - All game state changes are logged to the SQL audit trail
 *   - Secrets are verified (SHA3 check) before any balance update
 *   - MAST dispute handler monitors for on-chain coins with active bets
 *   - No txnpost auto:true — explicit 3-step signing on all paths
 *
 * ============================================================================
 */


/* ---- Load all libraries ---- */
MDS.load("./js/jslib.js");
MDS.load("./js/decimal.js");
MDS.load("./js/utils.js");
MDS.load("./js/auth.js");
MDS.load("./js/mast.js");
MDS.load("./js/txns.js");
MDS.load("./js/sql.js");
MDS.load("./js/messages.js");
MDS.load("./js/maxima.js");
MDS.load("./js/mast-txns.js");
MDS.load("./js/casino.js");
MDS.load("./js/props.js");
MDS.load("./js/channelfunction.js");


/* ---- Logging ---- */
var SHOW_LOGS = true;
function log(msg){
	if(SHOW_LOGS){ MDS.log(msg); }
}


/* ---- UI Communication ---- */

/**
 * Notify the frontend (index.html) to refresh the channel list.
 * Uses MDS.comms.solo to send a message to the frontend page.
 */
function showChannels(hashid){
	var msg     = {};
	msg.type    = "REFRESH_CHANNEL";
	msg.hashid  = hashid;
	MDS.comms.solo(JSON.stringify(msg));
}

/**
 * Notify the frontend that a channel is closing.
 */
function closingChannel(hashid){
	var msg     = {};
	msg.type    = "CLOSING_CHANNEL";
	msg.hashid  = hashid;
	MDS.comms.solo(JSON.stringify(msg));
}

/**
 * Notify the frontend about a game event (for real-time UI updates).
 */
function gameEvent(hashid, eventtype, data){
	var msg     = {};
	msg.type    = "GAME_EVENT";
	msg.hashid  = hashid;
	msg.event   = eventtype;
	msg.data    = data;
	MDS.comms.solo(JSON.stringify(msg));
}


/* ---- Unilateral close helpers ---- */

/**
 * Post the settlement transaction (last resort, after ELTOO coin has aged).
 */
function settle(hashid, callback){
	sqlSelectChannel(hashid, function(sql){
		postTxn(sql.rows[0].SETTLETXN, true, function(postresp){
			if(callback){ callback(); }
		});
	});
}

/**
 * Post the update transaction (to override an old on-chain state).
 */
function update(hashid, callback){
	sqlSelectChannel(hashid, function(sql){
		postTxn(sql.rows[0].UPDATETXN, true, function(postresp){
			if(callback){ callback(); }
		});
	});
}


/* =========================================================================
 * MAIN EVENT HANDLER
 * =========================================================================
 * MDS.init is called once with "inited", then continuously with events.
 * ========================================================================= */

MDS.init(function(msg){

	/* ==================================================================
	 * EVENT: INITED — One-time setup
	 * ================================================================== */
	if(msg.event == "inited"){

		// Create database tables (safe to call repeatedly — IF NOT EXISTS)
		createDB(function(){
			// Load our Maxima identity and Minima address
			initAuthDetails(function(){
				log("Thunder Casino service.js initialized");
			});
		});


	/* ==================================================================
	 * EVENT: NEWBLOCK — Periodic on-chain monitoring
	 * ==================================================================
	 * Runs every block. We use it to:
	 *   1. Check for closed channels (funding spent + payout found)
	 *   2. Every 5 blocks: scan for ELTOO coins on-chain
	 *      - If an ELTOO coin exists with OUR channel's address,
	 *        someone has started a unilateral close
	 *      - We check the sequence and coinage to decide what to do
	 *      - If game is active (phase=1), trigger MAST dispute handler
	 * ================================================================== */
	}else if(msg.event == "NEWBLOCK"){

		// Check for channels that are ready to be marked as closed
		updateClosedChannels(function(found){
			if(found){ showChannels("0x00"); }
		});

		// Only do the expensive ELTOO scan every 5 blocks
		var block = +msg.data.txpow.header.block;
		if(block % 5 != 0){ return; }

		// Scan for ALL relevant coins on-chain
		MDS.cmd("coins simplestate:true relevant:true", function(allcoins){
			var coincount = allcoins.response.length;

			// Get our channel addresses
			sqlSelectEltooChannels(function(eltoocoins){

				// Check each on-chain coin against our channels
				for(var i=0; i<coincount; i++){
					var coinrow     = allcoins.response[i];
					var coinaddress = coinrow.miniaddress;

					for(var j=0; j<eltoocoins.count; j++){
						var eltoorow      = eltoocoins.rows[j];
						var eltoohashid   = eltoorow.HASHID;
						var eltooaddress  = eltoorow.ELTOOADDRESS;
						var eltoosequence = eltoorow.SEQUENCE;

						// Does this on-chain coin match one of our channel addresses?
						if(eltooaddress == coinaddress){

							var age = coinrow.age;
							var seq = coinrow.state[101]; // Sequence from on-chain state

							// Check the game phase on the on-chain coin
							var onchainPhase = coinrow.state[102] || "0";

							// CASE 1: On-chain sequence is LOWER than our latest
							// → Someone posted an old state. We need to post our newer update.
							if(eltoosequence > seq){

								if(seq == 0){
									insertLog(eltoohashid, "TRIGGER_ELTOO_FOUND",
										"Trigger ELTOO coin found. Coinage:"+age+"/"+MIN_UPDATE_COINAGE
										+" Waiting to post latest update (seq:"+eltoosequence+")");
								}else{
									insertLog(eltoohashid, "INVALID_ELTOO_SEQUENCE",
										"Old ELTOO sequence on-chain ("+seq+"), ours is "+eltoosequence
										+". Coinage:"+age+"/"+MIN_UPDATE_COINAGE);
								}

								// Post our latest update once the coin is old enough
								if(age >= MIN_UPDATE_COINAGE){
									insertLog(eltoohashid, "POST_LATEST_UPDATE",
										"Posting latest update txn. Sequence:"+eltoosequence);
									update(eltoohashid, function(){
										showChannels(eltoohashid);
									});
								}else{
									showChannels(eltoohashid);
								}

							// CASE 2: On-chain sequence matches our latest
							// → This is the correct latest state. Wait for settlement.
							}else{

								// Is there an active game on this coin?
								if(onchainPhase == "1"){
									// GAME ACTIVE ON-CHAIN — trigger MAST dispute handler
									insertLog(eltoohashid, "GAME_ACTIVE_ONCHAIN",
										"ELTOO coin on-chain with active game (phase=1). Coinage:"+age);

									handleMastDispute(eltoohashid, age, function(action){
										if(action){
											log("MAST action taken: "+action+" for "+eltoohashid);
										}
										showChannels(eltoohashid);
									});

								}else{
									// Normal settlement (no game active)
									insertLog(eltoohashid, "VALID_ELTOO_FOUND",
										"Valid ELTOO coin. Coinage:"+age+"/"+MIN_SETTLE_COINAGE
										+" Sequence:"+eltoosequence);

									if(age >= MIN_SETTLE_COINAGE){
										insertLog(eltoohashid, "POST_SETTLEMENT",
											"Posting settlement txn. Sequence:"+eltoosequence);
										settle(eltoohashid, function(){
											showChannels(eltoohashid);
										});
									}else{
										showChannels(eltoohashid);
									}
								}
							}
						}
					}
				}
			});
		});


	/* ==================================================================
	 * EVENT: NEWCOIN — Track funding and payout coins
	 * ==================================================================
	 * Fires when a coin relevant to us appears or is spent.
	 * We use this to detect:
	 *   - Funding coin created (channel is live)
	 *   - Funding coin spent (channel closing)
	 *   - Payout coin found (our settlement funds arrived)
	 * ================================================================== */
	}else if(msg.event == "NEWCOIN"){

		// ---- Check if it's a FUNDING coin ----
		sqlSelectRelevantFundingCoin(msg.data.coin.miniaddress, function(resfund){
			if(resfund.count > 0){
				var sqlrow = resfund.rows[0];

				// Calculate expected payout (our share)
				var payout = "";
				if(sqlrow.STATE == "STATE_CHANNEL_OPEN_1"){
					payout = sqlrow.USER1AMOUNT;
				}else{
					payout = sqlrow.USER2AMOUNT;
				}

				if(msg.data.coin.spent){
					// Funding coin was SPENT — channel is closing
					insertLog(sqlrow.HASHID, "FUNDING_COIN_SPENT",
						"Funding coin spent. Address:"+msg.data.coin.miniaddress
						+" Total:"+msg.data.coin.amount+" Our payout:"+payout);

					updateFundingSpent(sqlrow.HASHID, function(){
						// If our payout is zero, mark as received immediately
						if(new Decimal(payout).equals(DECIMAL_ZERO)){
							updatePayoutFound(sqlrow.HASHID, '0', function(){
								showChannels(sqlrow.HASHID);
							});
						}else{
							showChannels(sqlrow.HASHID);
						}
					});

				}else{
					// New funding coin — channel is live
					insertLog(sqlrow.HASHID, "NEW_FUNDING_COIN",
						"Funding coin created. Address:"+msg.data.coin.miniaddress
						+" Total:"+msg.data.coin.amount);
					showChannels(sqlrow.HASHID);
				}
			}
		});

		// ---- Check if it's a PAYOUT coin ----
		if(!msg.data.coin.spent){
			var payout = msg.data.coin.state["200"]; // Hashid stored in port 200
			if(payout === undefined){ return; }

			sqlSelectPayoutCoin(msg.data.coin.miniaddress, function(respayout){
				for(var i=0; i<respayout.count; i++){
					var hashid = respayout.rows[i].HASHID;

					if(payout == hashid){
						insertLog(hashid, "PAYOUT_COIN_FOUND",
							"Payout received! Address:"+msg.data.coin.miniaddress
							+" Amount:"+msg.data.coin.amount);

						updatePayoutFound(hashid, msg.data.coin.amount, function(){
							showChannels(hashid);
						});
					}
				}
			});
		}


	/* ==================================================================
	 * EVENT: MAXIMA — Incoming messages from counterparty
	 * ==================================================================
	 * All messages come through the "thunderpay" Maxima application ID.
	 * We route based on the message type.
	 *
	 * Channel management messages are handled exactly as in Thunder 1.0.1.
	 * Game messages are new and implement the commit-reveal protocol.
	 * ================================================================== */
	}else if(msg.event == "MAXIMA"){

		// Log ALL incoming Maxima messages for debugging
		MDS.log("SERVICE.JS MAXIMA EVENT: app="+msg.data.application+" from="+msg.data.from.substring(0,20)+"..");

		// Only process messages for our application
		if(msg.data.application != "thunderpay"){ return; }

		var maximapubkey = msg.data.from;
		var datahex      = msg.data.data;

		// Decode the JSON message from hex
		convertHEXtoJSON(datahex, function(maxmsg){
			MDS.log("SERVICE.JS DECODED ["+maxmsg.type+"] hashid:"+(maxmsg.hashid||"none")+" from "+maximapubkey.substring(0,20)+"..");

			/* ---- ACK/SYNACK handshake ---- */
			if(maxmsg.type == "ACK_MESSAGE"){
				sendMaximaMessage(maximapubkey, synackMessage(maxmsg));
				return;
			}

			/* ==============================================================
			 * CHANNEL MANAGEMENT MESSAGES (from Thunder 1.0.1)
			 * ============================================================== */

			if(maxmsg.type == "REQUEST_NEW_CHANNEL"){

				// Validate the hashid
				if(!checkSafeHashID(maxmsg.hashid)){
					MDS.log("INVALID unsafe HashID: "+JSON.stringify(maxmsg));
					return;
				}

				// Validate amounts
				var you  = getValidDecimalNumber(maxmsg.useramount);
				var them = getValidDecimalNumber(maxmsg.requestamount);
				if(!checkStartValues(you.toString(), them.toString())){
					MDS.log("INVALID channel amounts: "+JSON.stringify(maxmsg));
					return;
				}
				if(you.greaterThan(MAX_CHANNEL_AMOUNT) || them.greaterThan(MAX_CHANNEL_AMOUNT)){
					MDS.log("INVALID channel amounts too large: "+you+" / "+them);
					return;
				}

				insertLog(maxmsg.hashid, "REQUEST_CHANNEL",
					"Channel requested by "+maxmsg.user.name);

				// Ensure hashid is unique
				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count > 0){
						MDS.log("INVALID non-unique HashID: "+maxmsg.hashid);
						return;
					}

					// Handle token import if needed
					if(maxmsg.tokenid != "0x00"){
						insertLog(maxmsg.hashid, "TOKEN_IMPORTED", "Token imported: "+maxmsg.tokenid);
						MDS.cmd("tokens action:import data:"+maxmsg.tokendata, function(tokimport){
							sqlInsertNewChannel(maxmsg, "STATE_REQUEST_START_CHANNEL", 2, function(){
								showChannels(maxmsg.hashid);
							});
						});
					}else{
						sqlInsertNewChannel(maxmsg, "STATE_REQUEST_START_CHANNEL", 2, function(){
							showChannels(maxmsg.hashid);
						});
					}
				});

			}else if(maxmsg.type == "CANCEL_NEW_CHANNEL"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_REQUEST_START_CHANNEL", function(valid){
					if(valid){
						insertLog(maxmsg.hashid, "CANCEL_CHANNEL", "User cancelled channel");
						updateChannelState(maxmsg.hashid, "STATE_REQUEST_CANCELLED", function(){
							showChannels(maxmsg.hashid);
						});
					}
				});

			}else if(maxmsg.type == "REQUEST_DENIED"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_SENT_START_CHANNEL", function(valid){
					if(valid){
						insertLog(maxmsg.hashid, "DENIED_CHANNEL", "User denied channel");
						updateChannelState(maxmsg.hashid, "STATE_REQUEST_DENIED", function(){
							showChannels(maxmsg.hashid);
						});
					}
				});

			}else if(maxmsg.type == "REQUEST_ACCEPTED"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_SENT_START_CHANNEL", function(valid){
					if(valid){
						insertLog(maxmsg.hashid, "REQUEST_ACCEPTED",
							"Channel accepted by "+maxmsg.user.name);

						updateChannelUser2(maxmsg.hashid, maxmsg.user, function(sqlrow){
							createDefaultTxnAndAddresses(maxmsg.hashid, true, function(alldata){
								addDefaultScripts(alldata, function(){
									updateChannelAddresses(maxmsg.hashid, alldata, function(){
										scriptsMMRTxn(alldata.transactions.fundingtxn, function(mmrtxn){
											alldata.transactions.fundingtxn = mmrtxn;
											signTriggerAndSettlement(alldata, sqlrow.USERPUBLICKEY, function(signeddata){
												sendCreateChannel("CHANNEL_CREATE_1", maximapubkey,
													maxmsg.hashid, signeddata, function(){
														showChannels(maxmsg.hashid);
													});
											});
										});
									});
								});
							});
						});
					}
				});

			}else if(maxmsg.type == "CHANNEL_CREATE_1"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_REQUEST_ACCEPTED", function(valid){
					if(valid){
						createDefaultTxnAndAddresses(maxmsg.hashid, false, function(alldata){
							checkDefaultTransactions(maxmsg.hashid, maxmsg.txndata, alldata, function(checkresp){
								if(!checkresp){
									insertLog(maxmsg.hashid, "INVALID_START_TXNS", "Invalid initial txns!");
									return;
								}
								addDefaultScripts(alldata, function(){
									updateChannelAddresses(maxmsg.hashid, alldata, function(sqlrow){
										addToFundingTxn(maxmsg.txndata.transactions.fundingtxn,
											sqlrow.USER2AMOUNT, sqlrow.TOKENID, function(newfundingtxn){
												scriptsMMRTxn(newfundingtxn, function(mmrtxn){
													maxmsg.txndata.transactions.fundingtxn = mmrtxn;
													signAllTxn(maxmsg.txndata, sqlrow.USERPUBLICKEY, function(signeddata){
														updateDefaultChannelTransactions(maxmsg.hashid, signeddata, function(){
															sendCreateChannel("CHANNEL_CREATE_2", maximapubkey,
																maxmsg.hashid, signeddata, function(){
																	showChannels(maxmsg.hashid);
																});
														});
													});
												});
											});
									});
								});
							});
						});
					}
				});

			}else if(maxmsg.type == "CHANNEL_CREATE_2"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_CHANNEL_CREATE_1", function(valid){
					if(!valid){ MDS.log("INVALID state for CHANNEL_CREATE_2"); return; }

					updateDefaultChannelTransactions(maxmsg.hashid, maxmsg.txndata, function(){
						signTxn(maxmsg.txndata.transactions.fundingtxn, "auto", function(signtxn){
							checkTxn(signtxn, function(resp){
								if(!resp.response.validtransaction){
									MDS.log("INVALID Funding transaction!");
									return;
								}
								postTxn(signtxn, false, function(postresp){
									insertLog(maxmsg.hashid, "POST_FUNDING_TXN", "Funding transaction posted!");
									updateChannelState(maxmsg.hashid, "STATE_CHANNEL_OPEN_1", function(){
										sendMaximaMessage(maximapubkey,
											replySimpleMessage(maxmsg.hashid, "CHANNEL_CREATE_3"), function(){
												showChannels(maxmsg.hashid);
											});
									});
								});
							});
						});
					});
				});

			}else if(maxmsg.type == "CHANNEL_CREATE_3"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_CHANNEL_CREATE_2", function(valid){
					if(!valid){ MDS.log("INVALID state for CHANNEL_CREATE_3"); return; }
					updateChannelState(maxmsg.hashid, "STATE_CHANNEL_OPEN_2", function(){
						showChannels(maxmsg.hashid);
					});
				});

			}else if(maxmsg.type == "SPEND_CHANNEL"){
				// Cooperative close — co-sign and post
				sqlSelectChannel(maxmsg.hashid, function(sql){
					var sqlrow = sql.rows[0];
					signTxn(maxmsg.spendfundingtxn, sqlrow.USERPUBLICKEY, function(fulltxn){
						postTxn(fulltxn, "true", function(postreq){
							insertLog(maxmsg.hashid, "POST_CHANNEL_CLOSE_COOP",
								"Cooperative close transaction posted");
							closingChannel(maxmsg.hashid);
						});
					});
				});

			}else if(maxmsg.type == "SEND_FUNDS"){
				// Standard fund transfer — co-sign the new state
				sqlSelectChannel(maxmsg.hashid, function(sql){
					var sqlrow = sql.rows[0];
					var sendamount = getValidDecimalNumber(maxmsg.amount);
					var newvalues = calculateNewValues(sqlrow, sendamount.toString(), sqlrow.USERNUM);
					if(!newvalues.valid){
						MDS.log("INVALID AMOUNT SENT: "+sendamount.toString());
						insertLog(maxmsg.hashid, "INVALID_AMOUNT_SENT",
							"Invalid amount: "+sendamount.toString());
						return;
					}

					insertLog(maxmsg.hashid, "FUNDS_RECEIVED", "Received "+maxmsg.amount);

					signTxn(maxmsg.settletxn, sqlrow.USERPUBLICKEY, function(newsettletxn){
						signTxn(maxmsg.updatetxn, sqlrow.USERPUBLICKEY, function(newupdatetxn){
							updateNewSequenceTxn(maxmsg.hashid, maxmsg.sequence,
								newvalues.useramount1.toString(), newvalues.useramount2.toString(),
								newsettletxn, newupdatetxn, function(){
									var replymsg = replySendChannelMessage(maxmsg.hashid,
										maxmsg.sequence, maxmsg.amount, newsettletxn, newupdatetxn);
									sendMaximaMessage(maximapubkey, replymsg, function(){
										showChannels(maxmsg.hashid);
									});
								});
						});
					});
				});

			}else if(maxmsg.type == "REPLY_SEND_FUNDS"){
				sqlSelectChannel(maxmsg.hashid, function(sql){
					var sqlrow = sql.rows[0];
					var sendamount = getValidDecimalNumber(maxmsg.amount);
					var newvalues = {};
					if(sqlrow.USERNUM == 1){
						newvalues = calculateNewValues(sqlrow, sendamount.toString(), 2);
					}else{
						newvalues = calculateNewValues(sqlrow, sendamount.toString(), 1);
					}
					insertLog(maxmsg.hashid, "FUNDS_SENT", "Sent "+sendamount.toString());
					updateNewSequenceTxn(maxmsg.hashid, maxmsg.sequence,
						newvalues.useramount1.toString(), newvalues.useramount2.toString(),
						maxmsg.settletxn, maxmsg.updatetxn, function(){
							showChannels(maxmsg.hashid);
						});
				});


			/* ==============================================================
			 * CASINO GAME MESSAGES
			 * ==============================================================
			 * Game protocol is handled in index.html's MAXIMA handler
			 * to enable browser console debugging and prevent duplicate
			 * processing between service.js and index.html.
			 *
			 * service.js only logs game messages for diagnostics.
			 * All game logic runs in index.html.
			 * ============================================================== */

			}else if(maxmsg.type == "GAME_REQUEST"){
				MDS.log("SERVICE.JS: GAME_REQUEST received (handled by index.html)");

			}else if(maxmsg.type == "GAME_OFFER"){
				MDS.log("SERVICE.JS: GAME_OFFER received (handled by index.html)");

			}else if(maxmsg.type == "GAME_ACCEPT"){
				MDS.log("SERVICE.JS: GAME_ACCEPT received (handled by index.html)");

			}else if(maxmsg.type == "GAME_BET_SIGNED"){
				MDS.log("SERVICE.JS: GAME_BET_SIGNED received (handled by index.html)");

			}else if(maxmsg.type == "GAME_REVEAL"){
				MDS.log("SERVICE.JS: GAME_REVEAL received (handled by index.html)");

			}else if(maxmsg.type == "GAME_RESULT"){
				MDS.log("SERVICE.JS: GAME_RESULT received (handled by index.html)");

			}else if(maxmsg.type == "GAME_RESULT_SIGNED"){
				MDS.log("SERVICE.JS: GAME_RESULT_SIGNED received (handled by index.html)");

			}else if(maxmsg.type == "GAME_ABANDONED"){
				MDS.log("SERVICE.JS: GAME_ABANDONED received (handled by index.html)");

			// Keep the old handlers below commented out for future service.js-only mode
			}else if(maxmsg.type == "GAME_REQUEST_DISABLED"){
				// ---- STEP 0: Someone wants to play against us ----
				// We auto-house: generate secret, commit, send back GAME_OFFER
				insertLog(maxmsg.hashid, "GAME_REQUEST_RECEIVED",
					"Game request: "+maxmsg.gametype+" bet:"+maxmsg.betamt
					+" pick:"+maxmsg.pick);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Validate the bet from our side (we're the house)
					var game = GAME_TYPES[maxmsg.gametype];
					if(!game){
						MDS.log("INVALID game type: "+maxmsg.gametype);
						sendMaximaMessage(maximapubkey,
							gameAbandonedMessage(maxmsg.hashid, "Invalid game type"));
						return;
					}

					// Bettor is the sender (the player requesting the game)
					var bettor = (sqlrow.USERNUM == 1) ? 2 : 1;

					var validation = validateBet(sqlrow, maxmsg.betamt, game.range, maxmsg.pick, bettor);
					if(!validation.valid){
						MDS.log("BET VALIDATION FAILED: "+validation.error);
						insertLog(maxmsg.hashid, "GAME_BET_INVALID", validation.error);
						sendMaximaMessage(maximapubkey,
							gameAbandonedMessage(maxmsg.hashid, "Bet invalid: "+validation.error));
						return;
					}

					// Auto-house: generate our secret and commit
					houseStartRound(maxmsg.hashid, maxmsg.gametype, function(data){
						if(!data){
							sendMaximaMessage(maximapubkey,
								gameAbandonedMessage(maxmsg.hashid, "House secret generation failed"));
							return;
						}

						// Store house commit on channel DB
						MDS.sql("UPDATE channels SET housecommit='"+data.commit+"' WHERE hashid='"+maxmsg.hashid+"'", function(){

							insertLog(maxmsg.hashid, "GAME_AUTO_HOUSE",
								"Auto-housing "+game.name+". House commit:"+data.commit.substring(0,16)+"..");

							// Send GAME_OFFER back to the player with our commit
							sendMaximaMessage(maximapubkey,
								gameOfferMessage(maxmsg.hashid, data.commit, maxmsg.gametype, game.range));
						});
					});
				});

			}else if(maxmsg.type == "GAME_OFFER"){
				// ---- STEP 1: We requested a game, house sent us their commit ----
				// Auto-commit: we already have our pick and bet stored, now commit
				insertLog(maxmsg.hashid, "GAME_OFFER_RECEIVED",
					"House commit received: "+maxmsg.housecommit.substring(0,16)+".."
					+" for "+maxmsg.gametype);

				// Retrieve our stored pick and bet from the pending game request
				MDS.keypair.get("casino_pending_"+maxmsg.hashid, function(pendingres){
					if(!pendingres.status || !pendingres.value){
						MDS.log("No pending game request found for "+maxmsg.hashid);
						// Notify frontend — this might be an unsolicited offer
						gameEvent(maxmsg.hashid, "GAME_OFFER", {
							housecommit: maxmsg.housecommit,
							gametype:    maxmsg.gametype,
							range:       maxmsg.range
						});
						return;
					}

					var pending = JSON.parse(pendingres.value);
					// pending = {gametype, pick, betamt}

					// Auto-accept: generate our secret, commit with pick and bet
					acceptGameRound(maxmsg.hashid, maxmsg.housecommit,
						pending.gametype, pending.pick, pending.betamt,
						function(delivered){
							if(delivered){
								insertLog(maxmsg.hashid, "GAME_AUTO_COMMIT",
									"Auto-committed. Pick:"+pending.pick+" Bet:"+pending.betamt);
								gameEvent(maxmsg.hashid, "GAME_COMMITTED", {});
							}else{
								insertLog(maxmsg.hashid, "GAME_COMMIT_FAILED",
									"Failed to deliver game accept");
								gameEvent(maxmsg.hashid, "GAME_ABANDONED", {reason: "Commit delivery failed"});
							}

							// Clear the pending request
							MDS.keypair.set("casino_pending_"+maxmsg.hashid, "");
						});
				});

			}else if(maxmsg.type == "GAME_ACCEPT"){
				// Player accepted our game offer
				insertLog(maxmsg.hashid, "GAME_ACCEPT_RECEIVED",
					"Player accepted! Pick:"+maxmsg.pick+" Bet:"+maxmsg.betamt
					+" Commit:"+maxmsg.playercommit.substring(0,16)+"..");

				// Validate the bet
				sqlSelectChannel(maxmsg.hashid, function(sql){
					var sqlrow = sql.rows[0];
					var game = GAME_TYPES[maxmsg.gametype];
					if(!game){
						MDS.log("INVALID game type in GAME_ACCEPT: "+maxmsg.gametype);
						return;
					}

					// The player (sender) is the bettor
					// We (receiver) are the house
					// bettor = the sender's usernum
					var bettor = (sqlrow.USERNUM == 1) ? 2 : 1; // Sender is the other user

					var validation = validateBet(sqlrow, maxmsg.betamt, game.range, maxmsg.pick, bettor);
					if(!validation.valid){
						MDS.log("BET VALIDATION FAILED: "+validation.error);
						insertLog(maxmsg.hashid, "GAME_BET_INVALID", validation.error);
						sendMaximaMessage(maximapubkey,
							gameAbandonedMessage(maxmsg.hashid, "Bet validation failed: "+validation.error));
						return;
					}

					// Sign the pessimistic balance
					// We need the house commit from our stored state
					// (it was set when we offered the game via offerGameRound)
					retrieveSecret(sqlrow.HOUSECOMMIT || "", "house", function(housesecret){
						// The house commit should already be stored from offerGameRound
						// But we need the commit hash, not the secret
						// Look it up from what we stored when we offered

						// Actually, we need the housecommit that we sent in GAME_OFFER
						// It's in our keypair from houseStartRound → storeSecret
						// The easiest way: store it on the channel when we offer

						// For now, read it from the channel's game state
						// (offerGameRound should have stored it — will be wired up)

						// Build the game bet transaction
						// FIX: pass bettor explicitly — the sender (player) is the bettor
						signGameBet(maxmsg.hashid, maxmsg.playercommit,
							sqlrow.HOUSECOMMIT, maxmsg.gametype, maxmsg.pick, maxmsg.betamt, bettor,
							function(settletxn, updatetxn){

								// Get the new sequence
								sqlSelectChannel(maxmsg.hashid, function(sql2){
									var newseq = sql2.rows[0].SEQUENCE;

									// Send the signed pessimistic balance to the player
									sendMaximaMessage(maximapubkey,
										gameBetSignedMessage(maxmsg.hashid, newseq, settletxn, updatetxn),
										function(){
											insertLog(maxmsg.hashid, "GAME_BET_SENT",
												"Pessimistic balance signed and sent to player");

											// AUTO-REVEAL: House reveals immediately after signing
											// No reason to wait — the bet is locked, we must reveal
											revealGameSecret(maxmsg.hashid, function(revealed){
												if(revealed){
													insertLog(maxmsg.hashid, "GAME_AUTO_REVEAL",
														"House auto-revealed secret after bet signing");
												}
												showChannels(maxmsg.hashid);
											});
										});
								});
							});
					});
				});

			}else if(maxmsg.type == "GAME_BET_SIGNED"){
				// House sent us the signed pessimistic balance
				// Co-sign and store it
				insertLog(maxmsg.hashid, "GAME_BET_COSIGN",
					"Received pessimistic balance. Co-signing. Sequence:"+maxmsg.sequence);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					var sqlrow = sql.rows[0];

					signTxn(maxmsg.settletxn, sqlrow.USERPUBLICKEY, function(cosignedsettletxn){
						signTxn(maxmsg.updatetxn, sqlrow.USERPUBLICKEY, function(cosignedupdatetxn){

							// Calculate pessimistic amounts
							var betamt = new Decimal(sqlrow.BETAMOUNT);
							var bettor = parseInt(sqlrow.BETTOR);
							var u1 = new Decimal(sqlrow.PREBETAMT1);
							var u2 = new Decimal(sqlrow.PREBETAMT2);
							var newu1, newu2;
							if(bettor == 1){
								newu1 = u1.sub(betamt).toString();
								newu2 = u2.plus(betamt).toString();
							}else{
								newu1 = u1.plus(betamt).toString();
								newu2 = u2.sub(betamt).toString();
							}

							updateNewSequenceTxn(maxmsg.hashid, maxmsg.sequence,
								newu1, newu2, cosignedsettletxn, cosignedupdatetxn, function(){

									insertLog(maxmsg.hashid, "GAME_BET_LOCKED",
										"Bet LOCKED. Pessimistic balance co-signed."
										+" User1:"+newu1+" User2:"+newu2);

									gameEvent(maxmsg.hashid, "BET_LOCKED", {});
									showChannels(maxmsg.hashid);
								});
						});
					});
				});

			}else if(maxmsg.type == "GAME_REVEAL"){
				// House revealed their secret — we can compute the outcome
				insertLog(maxmsg.hashid, "GAME_REVEAL_RECEIVED",
					"House secret received! Computing outcome...");

				// Store the house secret
				updateGameHouseRevealed(maxmsg.hashid, maxmsg.housesecret, function(){

					// AUTO-RESOLVE: Compute outcome and send result
					resolveGameRound(maxmsg.hashid, maxmsg.housesecret, function(winner, delivered){
						if(winner){
							insertLog(maxmsg.hashid, "GAME_AUTO_RESOLVE",
								"Auto-resolved! Winner:"+winner);
							gameEvent(maxmsg.hashid, "GAME_RESOLVED", {winner: winner});
						}
						showChannels(maxmsg.hashid);
					});
				});

			}else if(maxmsg.type == "GAME_RESULT"){
				// Player sent us the outcome and their secret
				insertLog(maxmsg.hashid, "GAME_RESULT_RECEIVED",
					"Result: "+maxmsg.winner+" ("+maxmsg.gametype+") Player secret received");

				// Store and verify
				sqlSelectChannel(maxmsg.hashid, function(sql){
					var sqlrow = sql.rows[0];

					// Verify the player's secret matches their commit
					MDS.cmd("hash data:"+maxmsg.playersecret, function(hashresp){
						var computed = hashresp.response.hash;
						if(computed !== sqlrow.PLAYERCOMMIT){
							MDS.log("CHEAT DETECTED: Player secret doesn't match commit!");
							insertLog(maxmsg.hashid, "GAME_CHEAT_PLAYER_SECRET",
								"Player secret SHA3 doesn't match commit! Cheating!");
							return;
						}

						// Independently verify the outcome
						computeOutcome(sqlrow.HOUSESECRET, maxmsg.playersecret,
							parseInt(sqlrow.GAMERANGE), function(outcome){

								var expectedWinner = (outcome.result == parseInt(sqlrow.PLAYERPICK))
									? "player" : "house";

								if(expectedWinner !== maxmsg.winner){
									MDS.log("CHEAT DETECTED: Player claims wrong winner!");
									insertLog(maxmsg.hashid, "GAME_CHEAT_WRONG_WINNER",
										"Player claims "+maxmsg.winner+" but result is "+expectedWinner);
									return;
								}

								// Result verified — store it
								var gameresult = (expectedWinner === "player") ? "LOSS" : "WIN"; // Our perspective as house
								updateGameResult(maxmsg.hashid, maxmsg.playersecret, gameresult, function(){
									insertLog(maxmsg.hashid, "GAME_RESULT_VERIFIED",
										"Result independently verified: "+expectedWinner);
									gameEvent(maxmsg.hashid, "GAME_RESULT_VERIFIED", {winner: expectedWinner});
								});
							});
					});
				});

			}else if(maxmsg.type == "GAME_RESULT_SIGNED"){
				// Counterparty sent us the signed resolved balance
				// Co-sign and complete the round
				insertLog(maxmsg.hashid, "GAME_RESULT_COSIGN",
					"Received resolved balance. Co-signing. Sequence:"+maxmsg.sequence);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					var sqlrow = sql.rows[0];

					// Calculate the correct resolved balance ourselves
					var winner = (sqlrow.GAMERESULT === "WIN") ? "house" : "player"; // From our DB
					// Actually need to determine winner properly
					var amIBettor = (sqlrow.USERNUM == parseInt(sqlrow.BETTOR));
					if(amIBettor){
						winner = (sqlrow.GAMERESULT === "WIN") ? "player" : "house";
					}else{
						winner = (sqlrow.GAMERESULT === "WIN") ? "house" : "player";
					}

					var newbalance = calculateGameBalance(sqlrow, winner);

					completeGameRound(maxmsg.hashid, maxmsg.sequence,
						maxmsg.settletxn, maxmsg.updatetxn,
						winner, newbalance.user1amount, newbalance.user2amount,
						function(updatedrow){
							insertLog(maxmsg.hashid, "GAME_COMPLETE",
								"Round complete! Ready for next game.");
							gameEvent(maxmsg.hashid, "GAME_COMPLETE", {
								winner: winner,
								user1amount: newbalance.user1amount,
								user2amount: newbalance.user2amount
							});
							showChannels(maxmsg.hashid);
						});
				});

			}else if(maxmsg.type == "GAME_ABANDONED"){
				insertLog(maxmsg.hashid, "GAME_ABANDONED",
					"Game abandoned by counterparty. Reason:"+maxmsg.reason);
				updateGameCleared(maxmsg.hashid, function(){
					gameEvent(maxmsg.hashid, "GAME_ABANDONED", {reason: maxmsg.reason});
					showChannels(maxmsg.hashid);
				});
			}
		});
	}
});
