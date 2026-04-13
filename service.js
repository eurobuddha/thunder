/**
 * ============================================================================
 * THUNDER CASINO — Background Service (THE BRAIN)
 * ============================================================================
 *
 * service.js processes ALL Maxima messages. It sends ONE clean notification
 * to index.html per event via MDS.comms.solo(). It NEVER touches the DOM.
 *
 * HANDLES:
 *   1. INITIALIZATION  — Create database, load identity
 *   2. NEWBLOCK        — Monitor ELTOO coins on-chain, trigger MAST disputes
 *   3. NEWCOIN         — Track funding/payout coins for channel state changes
 *   4. MAXIMA          — Process ALL incoming messages:
 *        a) Channel management (request, accept, create, close, send funds)
 *        b) Game protocol (request, offer, accept, bet-signed, reveal, result, result-signed)
 *        c) Props protocol (offer, accept, signed, settle, agreed, cancelled)
 *
 * CRITICAL RULES:
 *   - GAME_RESULT notification is sent ONLY from GAME_RESULT_SIGNED handler
 *   - The notification includes isMyWin (computed from usernum + winner)
 *   - No other handler sends game result information to index.html
 *   - All game state is managed in the DB, not in service.js variables
 *   - Error handling: if any step fails, send {type:"GAME_ABANDONED", reason:"..."}
 *
 * ============================================================================
 */


/* ---- Load all libraries (mast.js BEFORE txns.js) ---- */
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


/* ---- Notification helper ---- */

/**
 * Send ONE clean notification to index.html via MDS.comms.solo().
 * This is the ONLY way service.js communicates with the frontend.
 */
function notify(data){
	MDS.comms.solo(JSON.stringify(data));
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
			// Create props table
			createPropsTable(function(){
				// Load our Maxima identity and Minima address
				initAuthDetails(function(){
					log("Thunder Casino service.js initialized");
				});
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
			if(found){
				notify({type:"CHANNEL_CLOSED", hashid:"0x00"});
			}
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
							// Someone posted an old state. We need to post our newer update.
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
										notify({type:"CHANNEL_UPDATE", hashid:eltoohashid, state:"ELTOO_UPDATE"});
									});
								}else{
									notify({type:"CHANNEL_UPDATE", hashid:eltoohashid, state:"ELTOO_WAITING"});
								}

							// CASE 2: On-chain sequence matches our latest
							// This is the correct latest state. Wait for settlement.
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
										notify({type:"CHANNEL_UPDATE", hashid:eltoohashid, state:"MAST_DISPUTE"});
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
											notify({type:"CHANNEL_UPDATE", hashid:eltoohashid, state:"SETTLING"});
										});
									}else{
										notify({type:"CHANNEL_UPDATE", hashid:eltoohashid, state:"ELTOO_WAITING"});
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
								notify({type:"CHANNEL_CLOSED", hashid:sqlrow.HASHID});
							});
						}else{
							notify({type:"CHANNEL_UPDATE", hashid:sqlrow.HASHID, state:"CLOSING"});
						}
					});

				}else{
					// New funding coin — channel is live
					insertLog(sqlrow.HASHID, "NEW_FUNDING_COIN",
						"Funding coin created. Address:"+msg.data.coin.miniaddress
						+" Total:"+msg.data.coin.amount);
					notify({type:"CHANNEL_UPDATE", hashid:sqlrow.HASHID, state:"FUNDED"});
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
							notify({type:"CHANNEL_CLOSED", hashid:hashid});
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
	 * Channel management messages are from Thunder 1.0.1 (proven pattern).
	 * Game messages implement the commit-reveal protocol.
	 * Prop messages implement the prediction betting protocol.
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
								notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"STATE_REQUEST_START_CHANNEL"});
							});
						});
					}else{
						sqlInsertNewChannel(maxmsg, "STATE_REQUEST_START_CHANNEL", 2, function(){
							notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"STATE_REQUEST_START_CHANNEL"});
						});
					}
				});

			}else if(maxmsg.type == "CANCEL_NEW_CHANNEL"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_REQUEST_START_CHANNEL", function(valid){
					if(valid){
						insertLog(maxmsg.hashid, "CANCEL_CHANNEL", "User cancelled channel");
						updateChannelState(maxmsg.hashid, "STATE_REQUEST_CANCELLED", function(){
							notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"STATE_REQUEST_CANCELLED"});
						});
					}
				});

			}else if(maxmsg.type == "REQUEST_DENIED"){
				checkValidMaximaUserState(maximapubkey, maxmsg.hashid, "STATE_SENT_START_CHANNEL", function(valid){
					if(valid){
						insertLog(maxmsg.hashid, "DENIED_CHANNEL", "User denied channel");
						updateChannelState(maxmsg.hashid, "STATE_REQUEST_DENIED", function(){
							notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"STATE_REQUEST_DENIED"});
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
														notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"STATE_CHANNEL_CREATE_1"});
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
																	notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"STATE_CHANNEL_CREATE_2"});
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
												notify({type:"CHANNEL_OPEN", hashid:maxmsg.hashid});
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
						notify({type:"CHANNEL_OPEN", hashid:maxmsg.hashid});
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
							notify({type:"CHANNEL_CLOSED", hashid:maxmsg.hashid});
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
										notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"FUNDS_RECEIVED"});
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
							notify({type:"CHANNEL_UPDATE", hashid:maxmsg.hashid, state:"FUNDS_SENT"});
						});
				});


			/* ==============================================================
			 * CASINO GAME MESSAGES — THE COMPLETE FLOW
			 * ==============================================================
			 * All game logic runs HERE in service.js.
			 * index.html NEVER processes game Maxima messages.
			 * ============================================================== */

			}else if(maxmsg.type == "GAME_REQUEST"){
				/* ---- STEP 0: Someone wants to play against us (we're the house) ----
				 * Auto-house: validate bet, generate secret, commit, send GAME_OFFER
				 */
				insertLog(maxmsg.hashid, "GAME_REQUEST_RECEIVED",
					"Game request: "+maxmsg.gametype+" bet:"+maxmsg.betamt
					+" pick:"+maxmsg.pick);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Validate the game type
					var game = GAME_TYPES[maxmsg.gametype];
					if(!game){
						MDS.log("INVALID game type: "+maxmsg.gametype);
						sendMaximaMessage(maximapubkey,
							gameAbandonedMessage(maxmsg.hashid, "Invalid game type"));
						notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"Invalid game type"});
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
						notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:validation.error});
						return;
					}

					// Auto-house: generate our secret and commit
					houseStartRound(maxmsg.hashid, maxmsg.gametype, function(data){
						if(!data){
							sendMaximaMessage(maximapubkey,
								gameAbandonedMessage(maxmsg.hashid, "House secret generation failed"));
							notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"House secret generation failed"});
							return;
						}

						// Store house commit on channel DB
						MDS.sql("UPDATE channels SET housecommit='"+data.commit+"' WHERE hashid='"+maxmsg.hashid+"'", function(){

							insertLog(maxmsg.hashid, "GAME_AUTO_HOUSE",
								"Auto-housing "+game.name+". House commit:"+data.commit.substring(0,16)+"..");

							// Send GAME_OFFER back to the player with our commit
							sendMaximaMessage(maximapubkey,
								gameOfferMessage(maxmsg.hashid, data.commit, maxmsg.gametype, game.range));

							// Notify: game started, we are the house
							notify({
								type:     "GAME_STARTED",
								hashid:   maxmsg.hashid,
								gametype: maxmsg.gametype,
								betamt:   maxmsg.betamt,
								pick:     maxmsg.pick,
								role:     "house"
							});
						});
					});
				});

			}else if(maxmsg.type == "GAME_OFFER"){
				/* ---- STEP 1: We requested a game, house sent us their commit ----
				 * Auto-commit: retrieve pending game data, generate our secret, send GAME_ACCEPT
				 */
				insertLog(maxmsg.hashid, "GAME_OFFER_RECEIVED",
					"House commit received: "+maxmsg.housecommit.substring(0,16)+".."
					+" for "+maxmsg.gametype);

				// Retrieve our stored pick and bet from the pending game request
				MDS.keypair.get("casino_pending_"+maxmsg.hashid, function(pendingres){
					if(!pendingres.status || !pendingres.value){
						MDS.log("No pending game request found for "+maxmsg.hashid);
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

								// Notify: game started, we are the player
								notify({
									type:     "GAME_STARTED",
									hashid:   maxmsg.hashid,
									gametype: pending.gametype,
									betamt:   pending.betamt,
									pick:     pending.pick,
									role:     "player"
								});
							}else{
								insertLog(maxmsg.hashid, "GAME_COMMIT_FAILED",
									"Failed to deliver game accept");
								notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"Commit delivery failed"});
							}

							// Clear the pending request
							MDS.keypair.set("casino_pending_"+maxmsg.hashid, "");
						});
				});

			}else if(maxmsg.type == "GAME_ACCEPT"){
				/* ---- STEP 2: Player accepted our game offer (we're the house) ----
				 * Validate bet, sign pessimistic balance, send GAME_BET_SIGNED,
				 * then auto-reveal our secret.
				 */
				insertLog(maxmsg.hashid, "GAME_ACCEPT_RECEIVED",
					"Player accepted! Pick:"+maxmsg.pick+" Bet:"+maxmsg.betamt
					+" Commit:"+maxmsg.playercommit.substring(0,16)+"..");

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					var game = GAME_TYPES[maxmsg.gametype];
					if(!game){
						MDS.log("INVALID game type in GAME_ACCEPT: "+maxmsg.gametype);
						sendMaximaMessage(maximapubkey,
							gameAbandonedMessage(maxmsg.hashid, "Invalid game type"));
						notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"Invalid game type"});
						return;
					}

					// The player (sender) is the bettor
					// We (receiver) are the house
					var bettor = (sqlrow.USERNUM == 1) ? 2 : 1;

					var validation = validateBet(sqlrow, maxmsg.betamt, game.range, maxmsg.pick, bettor);
					if(!validation.valid){
						MDS.log("BET VALIDATION FAILED: "+validation.error);
						insertLog(maxmsg.hashid, "GAME_BET_INVALID", validation.error);
						sendMaximaMessage(maximapubkey,
							gameAbandonedMessage(maxmsg.hashid, "Bet validation failed: "+validation.error));
						notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:validation.error});
						return;
					}

					// Sign the pessimistic balance
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
											}else{
												insertLog(maxmsg.hashid, "GAME_REVEAL_FAILED",
													"House failed to reveal secret!");
												notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"House reveal failed"});
											}
										});
									});
							});
						});
				});

			}else if(maxmsg.type == "GAME_BET_SIGNED"){
				/* ---- STEP 3: House sent us the signed pessimistic balance (we're the player) ----
				 * Co-sign and store the pessimistic balance via updateNewSequenceTxn.
				 */
				insertLog(maxmsg.hashid, "GAME_BET_COSIGN",
					"Received pessimistic balance. Co-signing. Sequence:"+maxmsg.sequence);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
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

									// DO NOT notify game result here — wait for GAME_RESULT_SIGNED
								});
						});
					});
				});

			}else if(maxmsg.type == "GAME_REVEAL"){
				/* ---- STEP 4: House revealed their secret (we're the player) ----
				 * Store the secret, auto-resolve the round, send GAME_RESULT + GAME_RESULT_SIGNED.
				 * DO NOT notify yet — wait for counterparty's co-signed GAME_RESULT_SIGNED.
				 */
				insertLog(maxmsg.hashid, "GAME_REVEAL_RECEIVED",
					"House secret received! Computing outcome...");

				// Store the house secret
				updateGameHouseRevealed(maxmsg.hashid, maxmsg.housesecret, function(){

					// AUTO-RESOLVE: Compute outcome and send result
					resolveGameRound(maxmsg.hashid, maxmsg.housesecret, function(winner, delivered){
						if(winner){
							insertLog(maxmsg.hashid, "GAME_AUTO_RESOLVE",
								"Auto-resolved! Winner:"+winner);
							// DO NOT notify game result here — resolveGameRound sends
							// GAME_RESULT and GAME_RESULT_SIGNED to the counterparty.
							// The definitive notification comes from GAME_RESULT_SIGNED handler.
						}else{
							insertLog(maxmsg.hashid, "GAME_RESOLVE_FAILED",
								"Failed to resolve game round");
							notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"Resolution failed"});
						}
					});
				});

			}else if(maxmsg.type == "GAME_RESULT"){
				/* ---- STEP 5: Player sent us the outcome and their secret (we're the house) ----
				 * Verify the player's secret matches their commit.
				 * Independently compute outcome to verify.
				 * Build resolved balance, sign, and send GAME_RESULT_SIGNED.
				 */
				insertLog(maxmsg.hashid, "GAME_RESULT_RECEIVED",
					"Result: "+maxmsg.winner+" ("+maxmsg.gametype+") Player secret received");

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Verify the player's secret matches their commit
					MDS.cmd("hash data:"+maxmsg.playersecret, function(hashresp){
						var computed = hashresp.response.hash;
						if(computed !== sqlrow.PLAYERCOMMIT){
							MDS.log("CHEAT DETECTED: Player secret doesn't match commit!");
							insertLog(maxmsg.hashid, "GAME_CHEAT_PLAYER_SECRET",
								"Player secret SHA3 doesn't match commit! Cheating!");
							notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"Player cheat detected"});
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
									notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:"Player claims wrong winner"});
									return;
								}

								// Result verified — store it
								var gameresult = (expectedWinner === "player") ? "LOSS" : "WIN"; // Our perspective as house
								updateGameResult(maxmsg.hashid, maxmsg.playersecret, gameresult, function(){
									insertLog(maxmsg.hashid, "GAME_RESULT_VERIFIED",
										"Result independently verified: "+expectedWinner);

									// Build resolved balance and sign
									var newbalance = calculateGameBalance(sqlrow, expectedWinner);
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

															// Send the signed resolved-balance txns
															sendMaximaMessage(maximapubkey,
																gameResultSignedMessage(maxmsg.hashid, newsequence.toString(),
																	signedsettletxn, signedupdatetxn));

															insertLog(maxmsg.hashid, "GAME_RESULT_SIGNED_SENT",
																"Resolved balance signed and sent."
																+" Winner:"+expectedWinner
																+" User1:"+newbalance.user1amount
																+" User2:"+newbalance.user2amount);
														});
													});
												}
											);
										}
									);
								});
							});
					});
				});

			}else if(maxmsg.type == "GAME_RESULT_SIGNED"){
				/* ---- STEP 6: THE DEFINITIVE ROUND COMPLETE ----
				 * Counterparty sent us the signed resolved balance.
				 * Co-sign, store via completeGameRound, and send THE ONE notification.
				 *
				 * THIS IS THE ONLY HANDLER THAT SENDS GAME_RESULT NOTIFICATION.
				 */
				insertLog(maxmsg.hashid, "GAME_RESULT_COSIGN",
					"Received resolved balance. Co-signing. Sequence:"+maxmsg.sequence);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Determine winner from our DB
					var amIBettor = (sqlrow.USERNUM == parseInt(sqlrow.BETTOR));
					var winner;
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
								"Round complete! Winner:"+winner
								+" User1:"+newbalance.user1amount
								+" User2:"+newbalance.user2amount);

							// Compute isMyWin
							var isMyWin = false;
							if(amIBettor){
								isMyWin = (winner === "player");
							}else{
								isMyWin = (winner === "house");
							}

							// THE ONE NOTIFICATION — contains the definitive result
							notify({
								type:        "GAME_RESULT",
								hashid:      maxmsg.hashid,
								gametype:    sqlrow.GAMETYPE,
								winner:      winner,
								result:      sqlrow.GAMERESULT,
								pick:        parseInt(sqlrow.PLAYERPICK),
								betamt:      sqlrow.BETAMOUNT,
								user1amount: newbalance.user1amount,
								user2amount: newbalance.user2amount,
								sequence:    maxmsg.sequence,
								isMyWin:     isMyWin
							});
						});
				});

			}else if(maxmsg.type == "GAME_ABANDONED"){
				/* ---- Game abandoned by counterparty ---- */
				insertLog(maxmsg.hashid, "GAME_ABANDONED",
					"Game abandoned by counterparty. Reason:"+maxmsg.reason);
				updateGameCleared(maxmsg.hashid, function(){
					notify({type:"GAME_ABANDONED", hashid:maxmsg.hashid, reason:maxmsg.reason});
				});


			/* ==============================================================
			 * PROPS / WAGER MESSAGES
			 * ==============================================================
			 * Prediction betting on real-world events.
			 * Same pessimistic-commit model as casino games.
			 * ============================================================== */

			}else if(maxmsg.type == "PROP_OFFER"){
				/* ---- Someone proposed a bet to us ---- */
				insertLog(maxmsg.hashid, "PROP_OFFER_RECEIVED",
					"Prop offered: "+maxmsg.proposition+" Stake:"+maxmsg.mystake+" Wants:"+maxmsg.wantstake);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Validate the prop
					var proposer = (sqlrow.USERNUM == 1) ? 2 : 1; // Sender is the proposer
					var validation = validateProp(sqlrow, maxmsg.mystake, maxmsg.wantstake, maxmsg.proposition, proposer);
					if(!validation.valid){
						MDS.log("PROP VALIDATION FAILED: "+validation.error);
						insertLog(maxmsg.hashid, "PROP_INVALID", validation.error);
						return;
					}

					// Store the prop in our DB
					insertProp(maxmsg.hashid, maxmsg.proposition, proposer, maxmsg.side,
						maxmsg.mystake, maxmsg.wantstake, function(){

							notify({
								type:        "PROP_INCOMING",
								hashid:      maxmsg.hashid,
								proposition: maxmsg.proposition,
								mystake:     maxmsg.mystake,
								wantstake:   maxmsg.wantstake,
								side:        maxmsg.side,
								from:        maximapubkey
							});
						});
				});

			}else if(maxmsg.type == "PROP_ACCEPT"){
				/* ---- Counterparty accepted our prop — sign pessimistic balance, send PROP_SIGNED ---- */
				insertLog(maxmsg.hashid, "PROP_ACCEPT_RECEIVED",
					"Prop accepted by counterparty");

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Get the active prop
					selectActiveProp(maxmsg.hashid, function(propres){
						if(propres.count == 0){
							MDS.log("No active prop found for "+maxmsg.hashid);
							return;
						}
						var prop = propres.rows[0];

						// Update channel with prop data for MAST dispute
						updateChannelPropActive(maxmsg.hashid, prop.PROPOSITION, parseInt(prop.PROPOSER),
							prop.MYSTAKE, prop.WANTSTAKE, prop.PROPOSERSIDE, function(updatedrow){

								// Build pessimistic balance txns (proposer's stake deducted)
								var proposer = parseInt(prop.PROPOSER);
								var mystake = new Decimal(prop.MYSTAKE);
								var u1 = new Decimal(sqlrow.USER1AMOUNT);
								var u2 = new Decimal(sqlrow.USER2AMOUNT);
								var newu1, newu2;
								if(proposer == 1){
									newu1 = u1.sub(mystake).toString();
									newu2 = u2.plus(mystake).toString();
								}else{
									newu1 = u1.plus(mystake).toString();
									newu2 = u2.sub(mystake).toString();
								}

								var newsequence = new Decimal(sqlrow.SEQUENCE).plus(1);

								createSettlementTxn(
									sqlrow.HASHID, newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
									newu1, sqlrow.USER1ADDRESS,
									newu2, sqlrow.USER2ADDRESS,
									sqlrow.TOKENID, null,
									function(settletxn){
										createUpdateTxn(
											newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
											sqlrow.TOKENID, null,
											function(updatetxn){
												signTxn(settletxn, sqlrow.USERPUBLICKEY, function(signedsettletxn){
													signTxn(updatetxn, sqlrow.USERPUBLICKEY, function(signedupdatetxn){

														// Send signed pessimistic balance
														sendMaximaMessage(maximapubkey,
															propSignedMessage(maxmsg.hashid, newsequence.toString(),
																signedsettletxn, signedupdatetxn));

														// Update prop state to active
														updatePropState(maxmsg.hashid, 'active', function(){
															insertLog(maxmsg.hashid, "PROP_PESSIMISTIC_SENT",
																"Pessimistic balance signed and sent for prop");
															notify({type:"PROP_ACTIVE", hashid:maxmsg.hashid});
														});
													});
												});
											}
										);
									}
								);
							});
					});
				});

			}else if(maxmsg.type == "PROP_SIGNED"){
				/* ---- Counterparty sent signed pessimistic balance for our prop acceptance ---- */
				insertLog(maxmsg.hashid, "PROP_SIGNED_RECEIVED",
					"Prop pessimistic balance received. Co-signing. Sequence:"+maxmsg.sequence);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					signTxn(maxmsg.settletxn, sqlrow.USERPUBLICKEY, function(cosignedsettletxn){
						signTxn(maxmsg.updatetxn, sqlrow.USERPUBLICKEY, function(cosignedupdatetxn){

							// Calculate pessimistic amounts
							selectActiveProp(maxmsg.hashid, function(propres){
								if(propres.count == 0){ return; }
								var prop = propres.rows[0];
								var proposer = parseInt(prop.PROPOSER);
								var mystake = new Decimal(prop.MYSTAKE);
								var u1 = new Decimal(sqlrow.PREBETAMT1 || sqlrow.USER1AMOUNT);
								var u2 = new Decimal(sqlrow.PREBETAMT2 || sqlrow.USER2AMOUNT);
								var newu1, newu2;
								if(proposer == 1){
									newu1 = u1.sub(mystake).toString();
									newu2 = u2.plus(mystake).toString();
								}else{
									newu1 = u1.plus(mystake).toString();
									newu2 = u2.sub(mystake).toString();
								}

								updateNewSequenceTxn(maxmsg.hashid, maxmsg.sequence,
									newu1, newu2, cosignedsettletxn, cosignedupdatetxn, function(){

										updatePropState(maxmsg.hashid, 'active', function(){
											insertLog(maxmsg.hashid, "PROP_BET_LOCKED",
												"Prop bet LOCKED. Pessimistic balance co-signed.");
											notify({type:"PROP_ACTIVE", hashid:maxmsg.hashid});
										});
									});
							});
						});
					});
				});

			}else if(maxmsg.type == "PROP_SETTLE"){
				/* ---- Counterparty submitted their verdict ----
				 * Record their outcome. If both agree, build resolved balance.
				 */
				insertLog(maxmsg.hashid, "PROP_SETTLE_RECEIVED",
					"Counterparty verdict: "+maxmsg.outcome);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Determine who sent this (proposer or taker)
					var proposer = parseInt(sqlrow.BETTOR); // BETTOR stores proposer
					var senderIsProposer = false;
					if(sqlrow.USERNUM == 1){
						// We are user1, sender is user2
						senderIsProposer = (proposer == 2);
					}else{
						// We are user2, sender is user1
						senderIsProposer = (proposer == 1);
					}

					var who = senderIsProposer ? 'proposer' : 'taker';

					updatePropOutcome(maxmsg.hashid, who, maxmsg.outcome, function(){

						// Check if we have also submitted our verdict
						selectActiveProp(maxmsg.hashid, function(propres){
							if(propres.count == 0){ return; }
							var prop = propres.rows[0];

							var proposerOutcome = prop.PROPOSEROUTCOME;
							var takerOutcome = prop.TAKEROUTCOME;

							// Check if both sides have submitted
							if(proposerOutcome && proposerOutcome.length > 0 &&
							   takerOutcome && takerOutcome.length > 0){

								if(proposerOutcome === takerOutcome){
									// AGREEMENT — build resolved balance
									var agreedOutcome = proposerOutcome;

									insertLog(maxmsg.hashid, "PROP_AGREEMENT",
										"Both agree: "+agreedOutcome);

									// Determine winner
									var proposerSide = prop.PROPOSERSIDE;
									var winner;
									if(agreedOutcome === proposerSide){
										winner = "proposer";
									}else{
										winner = "taker";
									}

									var newbalance = calculatePropBalance(sqlrow, winner);
									var newsequence = new Decimal(sqlrow.SEQUENCE).plus(1);

									createSettlementTxn(
										sqlrow.HASHID, newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
										newbalance.user1amount, sqlrow.USER1ADDRESS,
										newbalance.user2amount, sqlrow.USER2ADDRESS,
										sqlrow.TOKENID, null,
										function(settletxn){
											createUpdateTxn(
												newsequence, sqlrow.ELTOOADDRESS, sqlrow.TOTALAMOUNT,
												sqlrow.TOKENID, null,
												function(updatetxn){
													signTxn(settletxn, sqlrow.USERPUBLICKEY, function(signedsettletxn){
														signTxn(updatetxn, sqlrow.USERPUBLICKEY, function(signedupdatetxn){
															sendMaximaMessage(maximapubkey,
																propAgreedMessage(maxmsg.hashid, newsequence.toString(),
																	signedsettletxn, signedupdatetxn, agreedOutcome));

															insertLog(maxmsg.hashid, "PROP_AGREED_SENT",
																"Agreement signed and sent. Winner:"+winner);
														});
													});
												}
											);
										}
									);
								}else{
									// DISPUTE — outcomes differ
									insertLog(maxmsg.hashid, "PROP_DISPUTE",
										"Outcomes differ! Proposer:"+proposerOutcome+" Taker:"+takerOutcome);
									updatePropDisputed(maxmsg.hashid, function(){
										notify({type:"PROP_DISPUTED", hashid:maxmsg.hashid});
									});
								}
							}else{
								// Still waiting for our side
								notify({type:"PROP_SETTLING", hashid:maxmsg.hashid, theirOutcome:maxmsg.outcome});
							}
						});
					});
				});

			}else if(maxmsg.type == "PROP_AGREED"){
				/* ---- Both sides agree — co-sign the resolved balance ---- */
				insertLog(maxmsg.hashid, "PROP_AGREED_RECEIVED",
					"Agreement received. Co-signing. Outcome:"+maxmsg.outcome);

				sqlSelectChannel(maxmsg.hashid, function(sql){
					if(sql.count == 0){ return; }
					var sqlrow = sql.rows[0];

					// Determine winner from the agreed outcome
					selectActiveProp(maxmsg.hashid, function(propres){
						if(propres.count == 0){ return; }
						var prop = propres.rows[0];

						var winner;
						if(maxmsg.outcome === prop.PROPOSERSIDE){
							winner = "proposer";
						}else{
							winner = "taker";
						}

						var newbalance = calculatePropBalance(sqlrow, winner);

						signTxn(maxmsg.settletxn, sqlrow.USERPUBLICKEY, function(cosignedsettletxn){
							signTxn(maxmsg.updatetxn, sqlrow.USERPUBLICKEY, function(cosignedupdatetxn){

								updateNewSequenceTxn(maxmsg.hashid, maxmsg.sequence,
									newbalance.user1amount, newbalance.user2amount,
									cosignedsettletxn, cosignedupdatetxn, function(){

										// Update prop as agreed
										updatePropAgreed(maxmsg.hashid, maxmsg.outcome, function(){

											// Clear game state on channel
											updateGameCleared(maxmsg.hashid, function(){

												// Determine if the win is ours
												var proposer = parseInt(prop.PROPOSER);
												var amIProposer = (sqlrow.USERNUM == proposer);
												var isMyWin = (amIProposer && winner === "proposer") ||
												              (!amIProposer && winner === "taker");

												insertLog(maxmsg.hashid, "PROP_COMPLETE",
													"Prop settled! Outcome:"+maxmsg.outcome+" Winner:"+winner
													+" User1:"+newbalance.user1amount+" User2:"+newbalance.user2amount);

												notify({
													type:        "PROP_SETTLED",
													hashid:      maxmsg.hashid,
													outcome:     maxmsg.outcome,
													winner:      winner,
													isMyWin:     isMyWin,
													user1amount: newbalance.user1amount,
													user2amount: newbalance.user2amount
												});
											});
										});
									});
							});
						});
					});
				});

			}else if(maxmsg.type == "PROP_CANCELLED"){
				/* ---- Proposer cancelled before we accepted ---- */
				insertLog(maxmsg.hashid, "PROP_CANCELLED",
					"Prop cancelled by proposer");

				updatePropState(maxmsg.hashid, 'cancelled', function(){
					notify({type:"PROP_CANCELLED", hashid:maxmsg.hashid});
				});

			}else if(maxmsg.type == "SYNACK_MESSAGE"){
				/* ---- SYNACK received — trigger the queued function ---- */
				synackMessageReceived(maxmsg);

			}else{
				MDS.log("UNKNOWN MESSAGE TYPE: "+maxmsg.type);
			}
		});
	}
});
