/**
 * Thunder Casino — MAST Branch Scripts, Proofs, and Root Hash
 *
 * Generated via mmrcreate on 2026-04-14 (multi-pick bitmask update)
 * 3 MAST leaves: claim (house), reclaim (player), dispute (player)
 *
 * Security: Every branch has SIGNEDBY + VERIFYOUT. No unguarded paths.
 * Addresses from PREVSTATE only — never getaddress.
 *
 * Multi-pick: Port 107 = bitmask of selected numbers.
 * Port 121 = number of picks. Payout = betamt * (range / numpicks).
 * Bit check: FLOOR(mask/POW(r 2)) mod 2 == 1
 */

//The MAST Root Hash — embedded in the main ELTOO script as: MAST 0x4D12...
var MAST_ROOT = "0xE4520BC17A0060FDBE937E71985B5FD96A1EECF47690238B015D8A07C08401B2";

/**
 * MAST Branch 1: House Claims Bet
 * Player walked away after losing. House claims pessimistic balance.
 * Requires: phase=1, coinage >= 256, signed by house (non-bettor)
 * VERIFYOUT enforces pessimistic payout to addresses in coin state
 */
var MAST_CLAIM_SCRIPT = "ASSERT PREVSTATE(102) EQ 1 ASSERT @COINAGE GTE 256 LET bt=PREVSTATE(108) IF bt EQ 1 THEN ASSERT SIGNEDBY(PREVSTATE(116)) ELSE ASSERT SIGNEDBY(PREVSTATE(115)) ENDIF LET a1=PREVSTATE(109) LET a2=PREVSTATE(110) LET v1=PREVSTATE(111) LET v2=PREVSTATE(112) LET ba=PREVSTATE(103) LET np=PREVSTATE(121) LET tb=ba*np IF bt EQ 1 THEN LET p1=v1-tb LET p2=v2+tb ELSE LET p1=v1+tb LET p2=v2-tb ENDIF IF p1 GT 0 THEN ASSERT VERIFYOUT(@INPUT a1 p1 @TOKENID FALSE) ENDIF IF p2 GT 0 THEN ASSERT VERIFYOUT(@INPUT+1 a2 p2 @TOKENID FALSE) ENDIF RETURN TRUE";

var MAST_CLAIM_PROOF = "0x00010000010200000000207A756C49223376A3BD15BD232894CD23D86BB52C5996A897D8F3E6EAF82483E400010000000000205AFF8F2A9F9082C26DB24E4C7E0D0257497DF94594E5A266B0129BFD52D4EE18000100";

/**
 * MAST Branch 2: Player Reclaims Bet
 * House disappeared without revealing. Player recovers pre-bet balance.
 * Requires: phase=1, coinage >= 1024, signed by player (bettor)
 * VERIFYOUT restores pre-bet amounts from coin state ports 111/112
 */
var MAST_RECLAIM_SCRIPT = "ASSERT PREVSTATE(102) EQ 1 ASSERT @COINAGE GTE 1024 LET bt=PREVSTATE(108) IF bt EQ 1 THEN ASSERT SIGNEDBY(PREVSTATE(115)) ELSE ASSERT SIGNEDBY(PREVSTATE(116)) ENDIF LET a1=PREVSTATE(109) LET a2=PREVSTATE(110) LET v1=PREVSTATE(111) LET v2=PREVSTATE(112) ASSERT VERIFYOUT(@INPUT a1 v1 @TOKENID FALSE) IF v2 GT 0 THEN ASSERT VERIFYOUT(@INPUT+1 a2 v2 @TOKENID FALSE) ENDIF RETURN TRUE";

var MAST_RECLAIM_PROOF = "0x0001000001020100000020CEC642DD1706D1E547888A29B41D31C23D9E6A5CFAA3B2FA03A06FAF1AE6FD1000010000000000205AFF8F2A9F9082C26DB24E4C7E0D0257497DF94594E5A266B0129BFD52D4EE18000100";

/**
 * MAST Branch 3: Player Dispute (Proves They Won)
 * Player won but house refuses to sign winning settlement.
 * Requires: phase=1, coinage >= 32, signed by player (bettor)
 * Multi-pick: Checks bitmask in port 107 using POW/FLOOR arithmetic
 * Payout scaled by numpicks in port 121: wn = ba * (rn / np)
 * VERIFYOUT enforces winning payout — cannot fake secrets or outcomes
 */
var MAST_DISPUTE_SCRIPT = "ASSERT PREVSTATE(102) EQ 1 ASSERT @COINAGE GTE 32 LET bt=PREVSTATE(108) IF bt EQ 1 THEN ASSERT SIGNEDBY(PREVSTATE(115)) ELSE ASSERT SIGNEDBY(PREVSTATE(116)) ENDIF LET hs=STATE(113) ASSERT SHA3(hs) EQ PREVSTATE(106) LET sc=STATE(114) ASSERT SHA3(sc) EQ PREVSTATE(105) LET h=SHA3(CONCAT(hs sc)) LET r=NUMBER(SUBSET(0 4 h))%PREVSTATE(104) LET mask=PREVSTATE(107) LET p=POW(r 2) LET d=FLOOR(mask/p) LET bit=d-2*FLOOR(d/2) ASSERT bit EQ 1 LET ba=PREVSTATE(103) LET rn=PREVSTATE(104) LET np=PREVSTATE(121) LET a1=PREVSTATE(109) LET a2=PREVSTATE(110) LET v1=PREVSTATE(111) LET v2=PREVSTATE(112) LET wn=ba*rn LET tb=ba*np IF bt EQ 1 THEN LET p1=v1+wn-tb LET p2=v2-wn+tb ELSE LET p1=v1-wn+tb LET p2=v2+wn-tb ENDIF IF p1 GT 0 THEN ASSERT VERIFYOUT(@INPUT a1 p1 @TOKENID FALSE) ENDIF IF p2 GT 0 THEN ASSERT VERIFYOUT(@INPUT+1 a2 p2 @TOKENID FALSE) ENDIF RETURN TRUE";

var MAST_DISPUTE_PROOF = "0x00010000010101000000208EF3A4BE0BFE0A7F2DE0250FC5333541DCDDD19130476C7D6324A1B7745E4D40000100";

/**
 * Attach a MAST proof to a transaction
 * Must be called BEFORE txnbasics
 *
 * @param txid - transaction id
 * @param mastScript - the MAST leaf script text
 * @param mastProof - the hex proof for that leaf
 * @param callback - function(success)
 */
function attachMAST(txid, mastScript, mastProof, callback){
	var scripts = {};
	scripts[mastScript] = mastProof;
	MDS.cmd("txnscript id:"+txid+" scripts:"+JSON.stringify(scripts), function(resp){
		if(!resp || !resp.status){
			MDS.log("MAST proof attach FAILED for txn:"+txid);
			if(callback){ callback(false); }
			return;
		}
		if(callback){ callback(true); }
	});
}
