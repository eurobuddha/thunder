#!/bin/bash
# ============================================================================
# TNZEC Channel Lifecycle Test
# ============================================================================
# Tests: open channel → play game → cooperative close
# Between Node 14005 (initiator) and Node 15015 (acceptor)
# Small amounts (5 Minima each side)
#
# This script can't call MDS functions directly — the channel operations
# happen inside the MiniDapp service.js. What we CAN test:
# 1. Maxima connectivity between nodes
# 2. Balance before/after
# 3. Coin state (funding coins, ELTOO coins, payout coins)
# 4. Channel DB state (via the test.html page)
#
# For the actual channel open/game/close, the user must use the UI.
# This script validates the on-chain state at each step.
# ============================================================================

NODE_A="http://127.0.0.1:14005"
NODE_B="http://127.0.0.1:15015"

pass() { echo -e "\033[32mPASS\033[0m — $1"; }
fail() { echo -e "\033[31mFAIL\033[0m — $1"; }
info() { echo -e "\033[33mINFO\033[0m — $1"; }
step() { echo ""; echo "=== STEP $1: $2 ==="; }

# ---- STEP 1: Connectivity ----
step 1 "Maxima Connectivity"

STATUS_A=$(curl -s "$NODE_A/status" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['version'])" 2>/dev/null)
STATUS_B=$(curl -s "$NODE_B/status" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['response']['version'])" 2>/dev/null)

if [ -n "$STATUS_A" ]; then pass "Node A (14005) online: v$STATUS_A"; else fail "Node A (14005) offline"; exit 1; fi
if [ -n "$STATUS_B" ]; then pass "Node B (15015) online: v$STATUS_B"; else fail "Node B (15015) offline"; exit 1; fi

# Get pubkeys
PK_A=$(curl -s "$NODE_A/maxima%20action:info" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['response']['publickey'])")
PK_B=$(curl -s "$NODE_B/maxima%20action:info" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['response']['publickey'])")
info "Node A PK: ${PK_A:0:20}..."
info "Node B PK: ${PK_B:0:20}..."

# Test message delivery both ways
SEND_AB=$(curl -s "$NODE_A/maxima%20action:send%20publickey:${PK_B}%20application:test%20data:0xDEAD" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response',{}).get('delivered',False))")
SEND_BA=$(curl -s "$NODE_B/maxima%20action:send%20publickey:${PK_A}%20application:test%20data:0xBEEF" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response',{}).get('delivered',False))")

if [ "$SEND_AB" = "True" ]; then pass "A → B Maxima delivery"; else fail "A → B delivery failed"; fi
if [ "$SEND_BA" = "True" ]; then pass "B → A Maxima delivery"; else fail "B → A delivery failed"; fi

# ---- STEP 2: Balances ----
step 2 "Pre-channel Balances"

BAL_A=$(curl -s "$NODE_A/balance" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print('sendable:',t['sendable']) for t in d['response'] if t['tokenid']=='0x00']")
BAL_B=$(curl -s "$NODE_B/balance" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print('sendable:',t['sendable']) for t in d['response'] if t['tokenid']=='0x00']")

info "Node A balance: $BAL_A"
info "Node B balance: $BAL_B"

# ---- STEP 3: Stuck transactions ----
step 3 "Stuck Transactions"

STUCK_A=$(curl -s "$NODE_A/txnlist" 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
r=d.get('response',{})
if isinstance(r,list): print(len(r))
elif isinstance(r,dict) and 'id' not in r: print(len(r))
else: print(0)
" 2>/dev/null)
STUCK_B=$(curl -s "$NODE_B/txnlist" 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
r=d.get('response',{})
if isinstance(r,list): print(len(r))
elif isinstance(r,dict) and 'id' not in r: print(len(r))
else: print(0)
" 2>/dev/null)

if [ "$STUCK_A" = "0" ]; then pass "Node A: no stuck txns"; else fail "Node A: $STUCK_A stuck txns — run txndelete id:all"; fi
if [ "$STUCK_B" = "0" ]; then pass "Node B: no stuck txns"; else fail "Node B: $STUCK_B stuck txns — run txndelete id:all"; fi

# ---- STEP 4: TNZEC installed ----
step 4 "TNZEC Installation"

TNZEC_A=$(curl -s "$NODE_A/mds" 2>/dev/null | python3 -c "
import json,sys; d=json.loads(sys.stdin.read())
for app in d['response']['minidapps']:
    if 'TNZEC' in app['conf'].get('name',''):
        print(app['conf']['version'], app['conf'].get('permission',''))
" 2>/dev/null)
TNZEC_B=$(curl -s "$NODE_B/mds" 2>/dev/null | python3 -c "
import json,sys; d=json.loads(sys.stdin.read())
for app in d['response']['minidapps']:
    if 'TNZEC' in app['conf'].get('name',''):
        print(app['conf']['version'], app['conf'].get('permission',''))
" 2>/dev/null)

if [ -n "$TNZEC_A" ]; then pass "Node A: TNZEC $TNZEC_A"; else fail "Node A: TNZEC not installed"; fi
if [ -n "$TNZEC_B" ]; then pass "Node B: TNZEC $TNZEC_B"; else fail "Node B: TNZEC not installed"; fi

# ---- STEP 5: Contact check ----
step 5 "Mutual Contacts"

HAS_B=$(curl -s "$NODE_A/maxcontacts%20action:search%20publickey:${PK_B}" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'] and d.get('response',{}).get('id') is not None)" 2>/dev/null)
HAS_A=$(curl -s "$NODE_B/maxcontacts%20action:search%20publickey:${PK_A}" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['status'] and d.get('response',{}).get('id') is not None)" 2>/dev/null)

if [ "$HAS_B" = "True" ]; then pass "A has B as contact"; else fail "A does not have B as contact"; fi
if [ "$HAS_A" = "True" ]; then pass "B has A as contact"; else fail "B does not have A as contact"; fi

# ---- STEP 6: On-chain coin state ----
step 6 "On-chain State"

COINS_A=$(curl -s "$NODE_A/coins%20relevant:true" 2>/dev/null | python3 -c "
import json,sys; d=json.load(sys.stdin)
eltoo=0; normal=0
for c in d['response']:
    if len(c.get('state',[])) > 0: eltoo+=1
    else: normal+=1
print(f'normal:{normal} eltoo:{eltoo}')
" 2>/dev/null)

info "Node A coins: $COINS_A"

echo ""
echo "============================================"
echo "PREFLIGHT COMPLETE"
echo "============================================"
echo ""
echo "Next steps (manual via TNZEC UI):"
echo "  1. Open TNZEC on Node A (https://127.0.0.1:14003)"
echo "  2. Open channel with Node B for 5/5 Minima"
echo "  3. Wait for channel to open (3/3)"
echo "  4. Play a dice game, bet 1"
echo "  5. Cooperative close the channel"
echo "  6. Run this script again to verify balances"
echo ""
echo "Expected after close:"
echo "  If you won:  A gets 5+winnings, B gets 5-winnings"
echo "  If you lost:  A gets 5-1=4, B gets 5+1=6"
echo "  Total should equal 10 (5+5)"
