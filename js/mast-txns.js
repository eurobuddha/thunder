/**
 * ============================================================================
 * THUNDER CASINO — MAST Dispute Transaction Builders
 * ============================================================================
 *
 * These functions build the on-chain dispute transactions that use MAST
 * branches to settle a channel when a game is active (phase=1) and the
 * parties can't agree cooperatively.
 *
 * There are THREE dispute paths, each with its own MAST branch:
 *
 *   1. HOUSE CLAIMS — Player walked away after losing
 *      - Available after 256 blocks
 *      - Signed by house only
 *      - VERIFYOUT enforces pessimistic payout (player lost their bet)
 *
 *   2. PLAYER RECLAIMS — House disappeared without revealing their secret
 *      - Available after 1024 blocks
 *      - Signed by player only
 *      - VERIFYOUT restores pre-bet balances (game never happened)
 *
 *   3. PLAYER DISPUTE — Player won but house refuses to sign the winning settlement
 *      - Available after 32 blocks (earliest — player gets priority)
 *      - Signed by player only
 *      - Provides both secrets in STATE for on-chain verification
 *      - Script computes SHA3(CONCAT(house_secret, player_secret)) % range
 *      - VERIFYOUT enforces winning payout
 *
 * TIMING PRIORITY:
 *   Block 32:   Player dispute first (if they won, they prove it before house can claim)
 *   Block 256:  House claims (if player walked away, house collects the bet)
 *   Block 1024: Player reclaims (if house disappeared, player gets money back)
 *
 * SECURITY:
 *   - Every path uses SIGNEDBY from PREVSTATE (key stored in coin state)
 *   - Every path uses VERIFYOUT to enforce exact output amounts and addresses
 *   - Addresses come from PREVSTATE only — never from getaddress at runtime
 *   - MAST proofs are attached via txnscript BEFORE txnbasics
 *   - All STATE ports are explicitly set to prevent Java VM crashes
 *
 * DEPENDENCIES:
 *   - mast.js  — MAST scripts, proofs, root hash, attachMAST helper
 *   - txns.js  — signTxn, postTxn, randomString
 *   - sql.js   — sqlSelectChannel
 *   - utils.js — Decimal, DECIMAL_ZERO
 *
 * ============================================================================
 */


/* =========================================================================
 * MAST BRANCH 1: HOUSE CLAIMS BET
 * =========================================================================
 *
 * USE CASE: The game round was started (phase=1), the pessimistic balance
 * is signed (player's bet already deducted), but the player walked away —
 * they refuse to cooperate because they lost.
 *
 * The house posts this transaction to claim the bet amount. The MAST
 * branch verifies:
 *   - Game is active (phase=1)
 *   - Coin has aged enough (256 blocks — player had time to dispute first)
 *   - Signed by the house (the non-bettor)
 *   - VERIFYOUT enforces pessimistic balance split to both addresses
 *
 * The pessimistic balance was set when the bet was placed:
 *   - If bettor=1: user1 gets (pre-bet - betamt), user2 gets (pre-bet + betamt)
 *   - If bettor=2: user1 gets (pre-bet + betamt), user2 gets (pre-bet - betamt)
 *
 * FLOW:
 *   1. Read channel data from DB
 *   2. Build transaction: input ELTOO coin, output to both user addresses
 *   3. Set STATE ports that the MAST script reads (all game data from coin)
 *   4. Attach MAST proof (BEFORE signing)
 *   5. Sign with house key
 *   6. Add txnbasics (AFTER signing, AFTER MAST)
 *   7. Post to network
 *
 * @param hashid   — Channel identifier
 * @param callback — Returns (success: boolean, error: string|null)
 * ========================================================================= */
function mastHouseClaim(hashid, callback){

	// Step 1: Get channel data
	sqlSelectChannel(hashid, function(sql){
		if(sql.count == 0){
			if(callback){ callback(false, "Channel not found: "+hashid); }
			return;
		}

		var sqlrow = sql.rows[0];
		var txid   = "mast_claim_" + randomString();

		// Determine who is the house (the NON-bettor)
		// bettor=1 means user1 is the player, so user2 is the house
		// bettor=2 means user2 is the player, so user1 is the house
		var bettor  = parseInt(sqlrow.BETTOR);
		var housekey = (bettor == 1) ? sqlrow.USER2PUBLICKEY : sqlrow.USER1PUBLICKEY;

		// Calculate the pessimistic payout amounts
		// These match what the MAST script computes from PREVSTATE
		var betamt = new Decimal(sqlrow.BETAMOUNT);
		var pre1   = new Decimal(sqlrow.PREBETAMT1);
		var pre2   = new Decimal(sqlrow.PREBETAMT2);
		var pay1, pay2;

		if(bettor == 1){
			// User1 is the player who lost: they lose betamt
			pay1 = pre1.sub(betamt);
			pay2 = pre2.plus(betamt);
		}else{
			// User2 is the player who lost: they lose betamt
			pay1 = pre1.plus(betamt);
			pay2 = pre2.sub(betamt);
		}

		var tokenid = sqlrow.TOKENID;

		// Step 2: Build the transaction
		// Count commands to find the txnexport index
		var cmds = [];
		cmds.push("txncreate id:"+txid);

		// Input: the ELTOO coin (floating = match by address not specific coinid)
		cmds.push("txninput id:"+txid+" tokenid:"+tokenid
			+" amount:"+sqlrow.TOTALAMOUNT+" address:"+sqlrow.ELTOOADDRESS+" floating:true");

		// Output to User 1 (skip if zero — player lost everything)
		if(pay1.greaterThan(DECIMAL_ZERO)){
			cmds.push("txnoutput id:"+txid+" tokenid:"+tokenid
				+" amount:"+pay1.toString()+" address:"+sqlrow.USER1ADDRESS+" storestate:false");
		}

		// Output to User 2 (skip if zero — player lost everything)
		if(pay2.greaterThan(DECIMAL_ZERO)){
			cmds.push("txnoutput id:"+txid+" tokenid:"+tokenid
				+" amount:"+pay2.toString()+" address:"+sqlrow.USER2ADDRESS+" storestate:false");
		}

		// Step 3: Set STATE ports
		// The MAST script reads these via STATE() in the spending transaction
		// settlement=TRUE because this IS a settlement (final spend)
		cmds.push("txnstate id:"+txid+" port:100 value:TRUE");
		cmds.push("txnstate id:"+txid+" port:101 value:"+sqlrow.SEQUENCE);
		cmds.push("txnstate id:"+txid+" port:200 value:"+sqlrow.HASHID);

		// Execute all commands as a batch
		var cmdstr = cmds.join(";") + ";";

		MDS.cmd(cmdstr, function(resp){

			// Step 4: Attach MAST proof (MUST be before signing and txnbasics)
			attachMAST(txid, MAST_CLAIM_SCRIPT, MAST_CLAIM_PROOF, function(mastok){
				if(!mastok){
					// Clean up on failure — prevent zombie transaction
					MDS.cmd("txndelete id:"+txid);
					if(callback){ callback(false, "MAST proof attach failed"); }
					return;
				}

				// Step 5: Sign with the house key
				MDS.cmd("txnsign id:"+txid+" publickey:"+housekey, function(signresp){
					if(!signresp || !signresp.status){
						MDS.cmd("txndelete id:"+txid);
						if(callback){ callback(false, "txnsign failed: "+JSON.stringify(signresp)); }
						return;
					}

					// Step 6: Add basics (fee calculation, MMR proofs)
					// MUST be after signing and after MAST attachment
					MDS.cmd("txnbasics id:"+txid, function(basicsresp){
						if(!basicsresp || !basicsresp.status){
							MDS.cmd("txndelete id:"+txid);
							if(callback){ callback(false, "txnbasics failed: "+JSON.stringify(basicsresp)); }
							return;
						}

						// Step 7: Post to network
						MDS.cmd("txnpost id:"+txid, function(postresp){

							// Clean up
							MDS.cmd("txndelete id:"+txid);

							// NOTE: txnpost status:true only means mempool, not confirmed.
							// We log and let the NEWBLOCK handler verify actual on-chain state.
							insertLog(hashid, "MAST_HOUSE_CLAIM",
								"House claimed bet via MAST dispute. Bettor:"+bettor
								+" BetAmt:"+betamt.toString()
								+" User1Payout:"+pay1.toString()
								+" User2Payout:"+pay2.toString());

							if(callback){ callback(true, null); }
						});
					});
				});
			});
		});
	});
}


/* =========================================================================
 * MAST BRANCH 2: PLAYER RECLAIMS BET
 * =========================================================================
 *
 * USE CASE: A game was started (phase=1) but the house disappeared —
 * they never revealed their secret. The player's bet is stuck in the
 * pessimistic balance. After 1024 blocks (~14 hours), the player can
 * reclaim their funds at the pre-bet balances.
 *
 * The MAST branch verifies:
 *   - Game is active (phase=1)
 *   - Coin has aged enough (1024 blocks — house had plenty of time)
 *   - Signed by the player (the bettor)
 *   - VERIFYOUT restores pre-bet balances from state ports 111/112
 *
 * This is the safety net — the player NEVER permanently loses money
 * to a disappeared house. The worst case is a 14-hour wait.
 *
 * @param hashid   — Channel identifier
 * @param callback — Returns (success: boolean, error: string|null)
 * ========================================================================= */
function mastPlayerReclaim(hashid, callback){

	// Step 1: Get channel data
	sqlSelectChannel(hashid, function(sql){
		if(sql.count == 0){
			if(callback){ callback(false, "Channel not found: "+hashid); }
			return;
		}

		var sqlrow = sql.rows[0];
		var txid   = "mast_reclaim_" + randomString();

		// The player is the bettor — get their signing key
		var bettor    = parseInt(sqlrow.BETTOR);
		var playerkey = (bettor == 1) ? sqlrow.USER1PUBLICKEY : sqlrow.USER2PUBLICKEY;

		// Pre-bet amounts — restore these as if the game never happened
		var pre1 = new Decimal(sqlrow.PREBETAMT1);
		var pre2 = new Decimal(sqlrow.PREBETAMT2);

		var tokenid = sqlrow.TOKENID;

		// Step 2: Build transaction
		var cmds = [];
		cmds.push("txncreate id:"+txid);

		// Input: the ELTOO coin
		cmds.push("txninput id:"+txid+" tokenid:"+tokenid
			+" amount:"+sqlrow.TOTALAMOUNT+" address:"+sqlrow.ELTOOADDRESS+" floating:true");

		// Output: restore pre-bet balance to User 1
		if(pre1.greaterThan(DECIMAL_ZERO)){
			cmds.push("txnoutput id:"+txid+" tokenid:"+tokenid
				+" amount:"+pre1.toString()+" address:"+sqlrow.USER1ADDRESS+" storestate:false");
		}

		// Output: restore pre-bet balance to User 2
		if(pre2.greaterThan(DECIMAL_ZERO)){
			cmds.push("txnoutput id:"+txid+" tokenid:"+tokenid
				+" amount:"+pre2.toString()+" address:"+sqlrow.USER2ADDRESS+" storestate:false");
		}

		// Step 3: STATE ports for the settlement
		cmds.push("txnstate id:"+txid+" port:100 value:TRUE");
		cmds.push("txnstate id:"+txid+" port:101 value:"+sqlrow.SEQUENCE);
		cmds.push("txnstate id:"+txid+" port:200 value:"+sqlrow.HASHID);

		var cmdstr = cmds.join(";") + ";";

		MDS.cmd(cmdstr, function(resp){

			// Step 4: Attach MAST proof
			attachMAST(txid, MAST_RECLAIM_SCRIPT, MAST_RECLAIM_PROOF, function(mastok){
				if(!mastok){
					MDS.cmd("txndelete id:"+txid);
					if(callback){ callback(false, "MAST reclaim proof failed"); }
					return;
				}

				// Step 5: Sign with player key
				MDS.cmd("txnsign id:"+txid+" publickey:"+playerkey, function(signresp){
					if(!signresp || !signresp.status){
						MDS.cmd("txndelete id:"+txid);
						if(callback){ callback(false, "txnsign failed: "+JSON.stringify(signresp)); }
						return;
					}

					// Step 6: Basics
					MDS.cmd("txnbasics id:"+txid, function(basicsresp){
						if(!basicsresp || !basicsresp.status){
							MDS.cmd("txndelete id:"+txid);
							if(callback){ callback(false, "txnbasics failed: "+JSON.stringify(basicsresp)); }
							return;
						}

						// Step 7: Post
						MDS.cmd("txnpost id:"+txid, function(postresp){
							MDS.cmd("txndelete id:"+txid);

							insertLog(hashid, "MAST_PLAYER_RECLAIM",
								"Player reclaimed bet — house disappeared. Pre-bet balances restored."
								+" User1:"+pre1.toString()+" User2:"+pre2.toString());

							if(callback){ callback(true, null); }
						});
					});
				});
			});
		});
	});
}


/* =========================================================================
 * MAST BRANCH 3: PLAYER DISPUTE (PROVES THEY WON)
 * =========================================================================
 *
 * USE CASE: The game played out off-chain — the house revealed their
 * secret, the player computed the outcome and WON, but the house refuses
 * to sign a settlement with the winning balance. The player uses this
 * MAST branch to prove on-chain that they won.
 *
 * The MAST branch verifies:
 *   - Game is active (phase=1)
 *   - Coin has aged enough (32 blocks — earliest priority)
 *   - Signed by the player (the bettor)
 *   - House secret matches house commit: SHA3(STATE(113)) == PREVSTATE(106)
 *   - Player secret matches player commit: SHA3(STATE(114)) == PREVSTATE(105)
 *   - Outcome computed: NUMBER(SUBSET(0,4, SHA3(CONCAT(hs,ps)))) % range
 *   - Player's pick matches the result: r == PREVSTATE(107)
 *   - VERIFYOUT enforces winning payout
 *
 * PAYOUT CALCULATION:
 *   winnings = betamt * range (e.g., dice: bet 10, range 6 → win 60)
 *   If bettor=1: user1 gets prebetamt1 + winnings - betamt
 *                user2 gets prebetamt2 - winnings + betamt
 *   The winnings include the player's own bet back plus the house's loss.
 *
 * SECURITY:
 *   - Player cannot fake secrets — SHA3 verification on-chain
 *   - Player cannot claim a loss as a win — outcome computed deterministically
 *   - If the player actually LOST and tries this, ASSERT r EQ pick fails
 *   - Addresses are from PREVSTATE — cannot be redirected
 *
 * @param hashid       — Channel identifier
 * @param housesecret  — The house's revealed secret (received via Maxima)
 * @param playersecret — The player's own secret
 * @param callback     — Returns (success: boolean, error: string|null)
 * ========================================================================= */
function mastPlayerDispute(hashid, housesecret, playersecret, callback){

	// Step 1: Get channel data
	sqlSelectChannel(hashid, function(sql){
		if(sql.count == 0){
			if(callback){ callback(false, "Channel not found: "+hashid); }
			return;
		}

		var sqlrow = sql.rows[0];
		var txid   = "mast_dispute_" + randomString();

		// The player is the bettor
		var bettor    = parseInt(sqlrow.BETTOR);
		var playerkey = (bettor == 1) ? sqlrow.USER1PUBLICKEY : sqlrow.USER2PUBLICKEY;

		// Calculate the winning payout
		// This MUST match what the on-chain script computes:
		//   wn = ba * rn (winnings = bet * range)
		//   If bettor=1: p1 = v1 + wn - ba, p2 = v2 - wn + ba
		//   If bettor=2: p1 = v1 - wn + ba, p2 = v2 + wn - ba
		var betamt = new Decimal(sqlrow.BETAMOUNT);
		var range  = new Decimal(sqlrow.GAMERANGE);
		var pre1   = new Decimal(sqlrow.PREBETAMT1);
		var pre2   = new Decimal(sqlrow.PREBETAMT2);

		var winnings = betamt.mul(range);  // Total winnings (includes bet return)
		var pay1, pay2;

		if(bettor == 1){
			// User1 is the winning player
			pay1 = pre1.plus(winnings).sub(betamt);   // pre + (bet*range) - bet = pre + bet*(range-1)
			pay2 = pre2.sub(winnings).plus(betamt);    // pre - (bet*range) + bet = pre - bet*(range-1)
		}else{
			// User2 is the winning player
			pay1 = pre1.sub(winnings).plus(betamt);
			pay2 = pre2.plus(winnings).sub(betamt);
		}

		// Safety check: payouts must not be negative
		// This should never happen if bet sizes are validated at channel level
		if(pay1.lessThan(DECIMAL_ZERO) || pay2.lessThan(DECIMAL_ZERO)){
			if(callback){ callback(false, "Invalid payout — negative balance. pay1:"+pay1+" pay2:"+pay2); }
			return;
		}

		var tokenid = sqlrow.TOKENID;

		// Step 2: Build transaction
		var cmds = [];
		cmds.push("txncreate id:"+txid);

		// Input: the ELTOO coin
		cmds.push("txninput id:"+txid+" tokenid:"+tokenid
			+" amount:"+sqlrow.TOTALAMOUNT+" address:"+sqlrow.ELTOOADDRESS+" floating:true");

		// Output to User 1 (winner or loser depending on bettor)
		if(pay1.greaterThan(DECIMAL_ZERO)){
			cmds.push("txnoutput id:"+txid+" tokenid:"+tokenid
				+" amount:"+pay1.toString()+" address:"+sqlrow.USER1ADDRESS+" storestate:false");
		}

		// Output to User 2
		if(pay2.greaterThan(DECIMAL_ZERO)){
			cmds.push("txnoutput id:"+txid+" tokenid:"+tokenid
				+" amount:"+pay2.toString()+" address:"+sqlrow.USER2ADDRESS+" storestate:false");
		}

		// Step 3: STATE ports
		// Standard ELTOO ports
		cmds.push("txnstate id:"+txid+" port:100 value:TRUE");
		cmds.push("txnstate id:"+txid+" port:101 value:"+sqlrow.SEQUENCE);
		cmds.push("txnstate id:"+txid+" port:200 value:"+sqlrow.HASHID);

		// DISPUTE-SPECIFIC: Provide both secrets in STATE
		// The MAST script reads these via STATE(113) and STATE(114)
		// and verifies them against the committed hashes in PREVSTATE(105/106)
		//
		// This is the key security mechanism:
		//   SHA3(STATE(113)) must equal PREVSTATE(106) — house commit
		//   SHA3(STATE(114)) must equal PREVSTATE(105) — player commit
		//
		// If either secret is wrong, the on-chain ASSERT fails and the
		// transaction is rejected. You cannot fake a secret that hashes
		// to someone else's commitment.
		cmds.push("txnstate id:"+txid+" port:113 value:"+housesecret);
		cmds.push("txnstate id:"+txid+" port:114 value:"+playersecret);

		var cmdstr = cmds.join(";") + ";";

		MDS.cmd(cmdstr, function(resp){

			// Step 4: Attach MAST proof
			attachMAST(txid, MAST_DISPUTE_SCRIPT, MAST_DISPUTE_PROOF, function(mastok){
				if(!mastok){
					MDS.cmd("txndelete id:"+txid);
					if(callback){ callback(false, "MAST dispute proof failed"); }
					return;
				}

				// Step 5: Sign with player key
				MDS.cmd("txnsign id:"+txid+" publickey:"+playerkey, function(signresp){
					if(!signresp || !signresp.status){
						MDS.cmd("txndelete id:"+txid);
						if(callback){ callback(false, "txnsign failed: "+JSON.stringify(signresp)); }
						return;
					}

					// Step 6: Basics
					MDS.cmd("txnbasics id:"+txid, function(basicsresp){
						if(!basicsresp || !basicsresp.status){
							MDS.cmd("txndelete id:"+txid);
							if(callback){ callback(false, "txnbasics failed: "+JSON.stringify(basicsresp)); }
							return;
						}

						// Step 7: Post
						MDS.cmd("txnpost id:"+txid, function(postresp){
							MDS.cmd("txndelete id:"+txid);

							insertLog(hashid, "MAST_PLAYER_DISPUTE",
								"Player proved they won via MAST dispute!"
								+" Bettor:"+bettor
								+" BetAmt:"+betamt.toString()
								+" Range:"+range.toString()
								+" Winnings:"+winnings.toString()
								+" User1Payout:"+pay1.toString()
								+" User2Payout:"+pay2.toString());

							if(callback){ callback(true, null); }
						});
					});
				});
			});
		});
	});
}


/* =========================================================================
 * AUTOMATIC MAST DISPUTE HANDLER (for service.js)
 * =========================================================================
 *
 * This function is called by service.js on NEWBLOCK events when an ELTOO
 * coin is detected on-chain with game phase=1. It determines which MAST
 * branch to execute based on the coin's age and our role in the channel.
 *
 * Decision tree:
 *
 *   Is game phase 1?
 *     ├── Am I the player (bettor)?
 *     │   ├── Do I have the house's secret? (from off-chain Maxima reveal)
 *     │   │   ├── Did I win?
 *     │   │   │   ├── YES → mastPlayerDispute() at 32+ blocks
 *     │   │   │   └── NO  → Do nothing (pessimistic balance is correct)
 *     │   │   └── NO secret → mastPlayerReclaim() at 1024+ blocks
 *     │   └── (wait for coinage threshold)
 *     └── Am I the house (non-bettor)?
 *         └── mastHouseClaim() at 256+ blocks
 *
 * @param hashid     — Channel identifier
 * @param coinage    — How many blocks old the ELTOO coin is
 * @param callback   — Returns action taken or null
 * ========================================================================= */
function handleMastDispute(hashid, coinage, callback){

	sqlSelectChannel(hashid, function(sql){
		if(sql.count == 0){
			if(callback){ callback(null); }
			return;
		}

		var sqlrow = sql.rows[0];
		var bettor = parseInt(sqlrow.BETTOR);

		// Determine our role: are we the player (bettor) or the house?
		var amIBettor = (sqlrow.USERNUM == bettor);

		if(amIBettor){
			// ---- WE ARE THE PLAYER ----

			// Do we have the house's secret? (stored in DB after Maxima reveal)
			var housesecret  = sqlrow.HOUSESECRET;
			var playersecret = sqlrow.PLAYERSECRET;

			if(housesecret && housesecret.length > 2){
				// We have the house's secret — we can compute the outcome
				// Check if we won (computed off-chain and stored in DB)
				if(sqlrow.GAMERESULT == "WIN" && coinage >= 32){
					// We won! Dispute to claim our winnings
					insertLog(hashid, "MAST_AUTO_DISPUTE",
						"Auto-triggering MAST dispute — we won and coinage is "+coinage+" (>=32)");

					mastPlayerDispute(hashid, housesecret, playersecret, function(ok, err){
						if(callback){ callback(ok ? "DISPUTE" : "DISPUTE_FAILED: "+err); }
					});

				}else{
					// We lost — the pessimistic balance is correct
					// No action needed. The house will claim at 256 blocks.
					insertLog(hashid, "MAST_AUTO_NOOP",
						"Game phase 1 on-chain but we lost. Pessimistic balance is correct. Coinage:"+coinage);
					if(callback){ callback(null); }
				}

			}else{
				// No house secret — house never revealed
				// Wait for reclaim threshold
				if(coinage >= 1024){
					insertLog(hashid, "MAST_AUTO_RECLAIM",
						"Auto-triggering MAST reclaim — house disappeared, coinage is "+coinage+" (>=1024)");

					mastPlayerReclaim(hashid, function(ok, err){
						if(callback){ callback(ok ? "RECLAIM" : "RECLAIM_FAILED: "+err); }
					});
				}else{
					insertLog(hashid, "MAST_AUTO_WAITING_RECLAIM",
						"House secret not found. Waiting for reclaim at 1024 blocks. Current coinage:"+coinage);
					if(callback){ callback(null); }
				}
			}

		}else{
			// ---- WE ARE THE HOUSE ----

			if(coinage >= 256){
				insertLog(hashid, "MAST_AUTO_CLAIM",
					"Auto-triggering MAST house claim — player walked away, coinage is "+coinage+" (>=256)");

				mastHouseClaim(hashid, function(ok, err){
					if(callback){ callback(ok ? "CLAIM" : "CLAIM_FAILED: "+err); }
				});
			}else{
				insertLog(hashid, "MAST_AUTO_WAITING_CLAIM",
					"Waiting for house claim at 256 blocks. Current coinage:"+coinage);
				if(callback){ callback(null); }
			}
		}
	});
}
