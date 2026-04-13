# Thunder Casino — Architecture (Clean Rebuild)

## The Problem

The UI shows wrong results because THREE different code paths process 
game messages. service.js, index.html MAXIMA handler, and index.html 
MDSCOMMS handler all compete to show results, increment stats, and 
update balances. This is fundamentally wrong.

## The Rule

```
service.js  = THE BRAIN  (processes ALL messages, updates DB)
index.html  = THE SCREEN (displays what the brain tells it, nothing more)
```

index.html NEVER processes Maxima messages directly.
index.html ONLY listens to MDSCOMMS notifications from service.js.
ONE notification per event. ONE display update per notification.

## Enforcement (why it's impossible to cheat)

The ELTOO smart contract + MAST branches enforce every scenario:

| Cheat attempt | Enforcement |
|---|---|
| Rage quit after losing | Pessimistic balance already deducted. Latest settlement wins. |
| Refuse to pay winner | MAST Branch 3: on-chain SHA3 proves the win. VERIFYOUT enforces payout. |
| Disappear without revealing | MAST Branch 2: player reclaims after 1024 blocks. |
| Revert to original stake | ELTOO: higher sequence ALWAYS wins. Can't post old state. |
| Fake secrets | SHA3(fake) ≠ committed hash. ASSERT fails on-chain. |
| App sweeps coins | VERIFYOUT on EVERY spending path. No unguarded SIGNEDBY. |
| Modify settlement amounts | MULTISIG: both must sign. Can't unilaterally change. |

## Message Flow (one path, no alternatives)

```
1. Maxima message arrives at BOTH service.js AND index.html
2. index.html IGNORES it (only handles SYNACK for ACK handshake)
3. service.js processes it:
   a. Validates the message
   b. Updates the database
   c. Builds/signs transactions as needed
   d. Sends ONE MDS.comms.solo() notification to index.html
4. index.html receives the MDSCOMMS notification
5. index.html calls ONE display function based on the notification type
6. DONE
```

## Notification Types (service.js → index.html)

```javascript
// Channel lifecycle
{type: "CHANNEL_UPDATE", hashid, state}          // channel state changed
{type: "CHANNEL_OPEN", hashid}                    // channel is now open
{type: "CHANNEL_CLOSED", hashid}                  // channel is closed

// Game lifecycle — ONE notification per phase
{type: "GAME_STARTED", hashid, gametype, betamt, pick}    // bet is locked
{type: "GAME_RESULT", hashid, gametype, winner, result,    // round complete
        pick, betamt, user1amount, user2amount, 
        sequence, isMyWin}

// Props lifecycle
{type: "PROP_OFFERED", hashid, proposition, mystake, wantstake, side}
{type: "PROP_ACTIVE", hashid}
{type: "PROP_SETTLED", hashid, outcome, winner}
{type: "PROP_INCOMING", hashid, proposition, mystake, wantstake, side, from}
```

## index.html Display Functions

```javascript
// ONE function per notification type. No alternatives.

function onChannelUpdate(data) { loadChannels(); }
function onChannelOpen(data) { loadChannels(); }
function onChannelClosed(data) { loadChannels(); }

function onGameStarted(data) {
    // Show: "Bet locked! [gametype] [betamt] on [pick]"
    // Start spin animation
    // Deduct bet from displayed balance
}

function onGameResult(data) {
    // THE ONLY PLACE that shows win/lose
    // THE ONLY PLACE that updates stats
    // THE ONLY PLACE that updates balance display
    
    if(data.isMyWin) {
        showWin(data);
        GAME_WINS++;
    } else {
        showLose(data);
        GAME_LOSSES++;
    }
    GAME_ROUNDS++;
    GAME_PROFIT = ... ;
    updateStats();
    addRoundPip();
    updateBalanceDisplay(data.user1amount, data.user2amount);
    // DONE. No other code path touches these.
}
```

## File Responsibilities

| File | Does | Does NOT |
|---|---|---|
| service.js | Process Maxima messages, update DB, sign txns, send notifications | Touch the DOM, show alerts, play sounds |
| index.html | Display notifications, handle user clicks, play sounds, animate | Process Maxima messages, sign txns, query coins |
| txns.js | Build transactions | Know about games or props |
| casino.js | Commit-reveal math, validation | Know about UI or messages |
| props.js | Prop validation, balance calc | Know about UI or messages |
| sql.js | Database CRUD | Know about Maxima or UI |
| messages.js | Message constructors | Process messages |
| maxima.js | Send/receive Maxima | Know about games |
| mast.js | MAST scripts and proofs | Know about anything else |
| mast-txns.js | Build dispute transactions | Know about UI |
| channelfunction.js | High-level channel+game operations | Touch the DOM |

## What We Keep (proven, don't touch)

- contracts/*.txt — KISS VM scripts, tested on Java VM
- js/mast.js — MAST root + proofs, generated via mmrcreate
- js/txns.js — transaction construction, cmdnum fixed
- js/casino.js — commit-reveal math (with props.js column fix)
- js/props.js — prop validation + balance calc (with column fix)
- js/sql.js — database schema + CRUD
- js/messages.js — message constructors
- js/maxima.js — Maxima send/receive
- js/mast-txns.js — MAST dispute builders
- js/channelfunction.js — channel lifecycle functions

## What We Rebuild

- service.js — move ALL game+prop handlers here, send clean notifications
- index.html — strip ALL Maxima handling, ONLY listen to MDSCOMMS
