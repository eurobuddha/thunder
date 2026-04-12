/**
 * ============================================================================
 * THUNDER PROPS — Prediction Betting Logic
 * ============================================================================
 *
 * Two players in a channel bet on real-world propositions.
 *
 * FLOW:
 *   1. Player A proposes: "England win the Euros" — bets 50 on TRUE
 *   2. Player B accepts: bets 50 on FALSE
 *   3. Both sign pessimistic balance (proposer's bet deducted)
 *   4. ... time passes, event happens ...
 *   5. Either player clicks SETTLE TRUE or SETTLE FALSE
 *   6. If both agree → balance updates instantly
 *   7. If they disagree → DISPUTED (future: arbiter resolves)
 *
 * DIFFERENCES FROM CASINO:
 *   - No commit-reveal randomness (outcome is real-world, not mathematical)
 *   - No time pressure on settlement (could take days/weeks)
 *   - Propositions are text strings, not game types
 *   - Settlement requires AGREEMENT, not computation
 *   - The bet can have custom odds (not just even money)
 *
 * SECURITY:
 *   - Same pessimistic commit model as casino
 *   - Proposer's bet deducted when both sign
 *   - If taker walks away → proposer claims via MAST at 256 blocks
 *   - If proposer walks away → taker reclaims via MAST at 1024 blocks
 *   - Settlement only changes balance when BOTH agree
 *
 * ODDS MODEL:
 *   - Proposer sets their stake and what they want from the taker
 *   - Example: "50 wants 50" = even money (1:1)
 *   - Example: "10 wants 50" = 5:1 (proposer thinks it's likely)
 *   - Example: "50 wants 10" = 1:5 (proposer thinks it's unlikely)
 *   - The taker sees the terms and decides to take or not
 *
 * STATE:
 *   Props are tracked in the SQL `props` table.
 *   Only ONE active prop per channel at a time (like casino games).
 *   The channel's gamephase column tracks: 0=idle, 1=casino bet, 2=prop active
 *
 * ============================================================================
 */


/* =========================================================================
 * PROP STATES
 * ========================================================================= */

var PROP_STATES = {
	OFFERED:    'offered',     // Proposer sent offer, waiting for taker
	ACTIVE:     'active',      // Both signed pessimistic balance, prop is live
	SETTLING:   'settling',    // One side submitted their outcome
	AGREED:     'agreed',      // Both agree on outcome, balance updated
	DISPUTED:   'disputed',    // Both submitted different outcomes
	EXPIRED:    'expired',     // Timed out with no taker
	CANCELLED:  'cancelled'    // Proposer cancelled before taker accepted
};


/* =========================================================================
 * PROP VALIDATION
 * ========================================================================= */

/**
 * Validate a proposed prop bet.
 *
 * @param sqlrow      — Channel data
 * @param mystake     — How much the proposer is betting
 * @param wantstake   — How much they want from the taker
 * @param proposition — The text of the proposition
 * @param proposer    — Who is proposing (1 or 2)
 * @returns           — {valid, error}
 */
function validateProp(sqlrow, mystake, wantstake, proposition, proposer){

	var my = new Decimal(mystake);
	var want = new Decimal(wantstake);

	if(my.lessThanOrEqualTo(DECIMAL_ZERO)){
		return {valid: false, error: "Your stake must be positive"};
	}

	if(want.lessThanOrEqualTo(DECIMAL_ZERO)){
		return {valid: false, error: "Requested stake must be positive"};
	}

	if(!proposition || proposition.trim().length < 3){
		return {valid: false, error: "Proposition must be at least 3 characters"};
	}

	if(proposition.length > 200){
		return {valid: false, error: "Proposition too long (max 200 chars)"};
	}

	// Check proposer has enough balance
	var proposerBalance = (proposer == 1)
		? new Decimal(sqlrow.USER1AMOUNT)
		: new Decimal(sqlrow.USER2AMOUNT);

	if(my.greaterThan(proposerBalance)){
		return {valid: false, error: "Insufficient balance. Have: "+proposerBalance+" Need: "+my};
	}

	// Check taker has enough balance for their side
	var takerBalance = (proposer == 1)
		? new Decimal(sqlrow.USER2AMOUNT)
		: new Decimal(sqlrow.USER1AMOUNT);

	if(want.greaterThan(takerBalance)){
		return {valid: false, error: "Counterparty insufficient balance. They have: "+takerBalance+" You want: "+want};
	}

	return {valid: true, error: null};
}


/* =========================================================================
 * PROP BALANCE CALCULATION
 * ========================================================================= */

/**
 * Calculate the resolved balance after a prop settles.
 *
 * @param sqlrow   — Channel data with PROPSTAKE, PROPWANT, PROPOSER
 * @param winner   — "proposer" or "taker"
 * @returns        — {user1amount, user2amount}
 */
function calculatePropBalance(sqlrow, winner){

	var mystake  = new Decimal(sqlrow.BETAMOUNT);    // stored via updateChannelPropActive
	var wantstake = new Decimal(sqlrow.HOUSECOMMIT); // reused column for wantstake
	var proposer = parseInt(sqlrow.BETTOR);           // reused column for proposer
	var pre1     = new Decimal(sqlrow.PREBETAMT1);
	var pre2     = new Decimal(sqlrow.PREBETAMT2);

	// Total pot = mystake + wantstake
	// Winner gets the full pot back on their side
	// Loser already had their stake deducted in the pessimistic balance

	if(winner === "proposer"){
		// Proposer wins: they get their stake back + taker's stake
		if(proposer == 1){
			return {
				user1amount: pre1.plus(wantstake).toString(),    // pre + what they won
				user2amount: pre2.sub(wantstake).toString()      // pre - what they lost
			};
		}else{
			return {
				user1amount: pre1.sub(wantstake).toString(),
				user2amount: pre2.plus(wantstake).toString()
			};
		}
	}else{
		// Taker wins: proposer loses their stake (already deducted in pessimistic)
		// Taker gets proposer's stake
		if(proposer == 1){
			return {
				user1amount: pre1.sub(mystake).toString(),       // proposer loses
				user2amount: pre2.plus(mystake).toString()       // taker wins
			};
		}else{
			return {
				user1amount: pre1.plus(mystake).toString(),
				user2amount: pre2.sub(mystake).toString()
			};
		}
	}
}
