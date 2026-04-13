# Thunder Casino — Complete UI/UX Specification v1.0

## Layout: 1080p, Zero Scrolling

```
+----------------------------------------------------------+ 0px
|  HEADER (50px): Logo | Node info | CASINO|PROPS|CHANNELS | 
+----------------------------------------------------------+ 50px
|                                                          |
|  CONTENT (900px): switches between tabs                  |
|                                                          |
+----------------------------------------------------------+ 950px
|  NOTICEBOARD (80px): always visible, 3 lines, scrollable |
+----------------------------------------------------------+ 1030px
```

Max content width: 900px centered. Modals: 520x440px centered overlay.

## The Core Change: GAME MODAL

Games play in a POPUP MODAL. Both player and house see it.

### Player's Modal:
```
+--------------------------------------------------+
|              ⚡ COIN FLIP                         |
|                                                    |
|  Your bet: 25 on TAILS                            |
|  House risks: 25                                  |
|                                                    |
|        [COIN SPINNING ANIMATION]                  |
|                                                    |
|  Result: TAILS ✓                                  |
|                                                    |
|  🎉 YOU WIN!                                      |
|  Won: +25                                         |
|  Balance: 100 → 125                               |
|                                                    |
|              [PLAY AGAIN]                          |
+--------------------------------------------------+
```

### House's Modal:
```
+--------------------------------------------------+
|              ⚡ COIN FLIP (HOUSING)               |
|                                                    |
|  Player bets: 25 on TAILS                         |
|  You risk: 25                                     |
|                                                    |
|        [SAME ANIMATION]                           |
|                                                    |
|  Result: TAILS                                    |
|  Player wins. YOU LOSE -25                        |
|  Balance: 100 → 75                                |
|                                                    |
|                [OK]                                |
+--------------------------------------------------+
```

## Cash Flow Messaging (EVERY game outcome)

### Coin Flip (1:1)
```
Bet 25 on TAILS. House risks 25.
WIN:  Result TAILS. Won +25. Balance 100 → 125.
LOSE: Result HEADS. Lost -25. Balance 100 → 75.
```

### Dice (5:1)
```
Bet 10 on 4. House risks 50.
WIN:  Result 4. Won +50. Balance 100 → 150.
LOSE: Result 2. Lost -10. Balance 100 → 90.
```

### Roulette (35:1)
```
Bet 2 on 17. House risks 70.
WIN:  Result 17. Won +70. Balance 100 → 170.
LOSE: Result 5. Lost -2. Balance 100 → 98.
```

House risk = bet × (range - 1).

## Modal Phases

1. **BET PLACED** → "Finding house..." with pulse animation
2. **BET LOCKED** → Gold flash, "BET LOCKED!", balance shows deduction
3. **SPINNING** → 4 second minimum, coin/dice/roulette animation
4. **RESULT** → Number revealed, WIN celebration or LOSE shake
5. **[PLAY AGAIN]** or **[OK]** → Modal closes, back to lobby

## Casino Lobby (behind the modal)

```
+------------------------------------------------------+
| Balance Bar: You: 100 | Channel: Alice | Them: 100   |
+------------------------------------------------------+
| Stats: W:3 L:2 P&L:+15 | FLIP 2/1 DICE 1/1 ROUL 0/0|
| Pips: [W][L][W][L][W]                                |
+------------------------------------------------------+
| Game Selector: [COIN FLIP] [DICE] [ROULETTE]         |
| Pick Grid: [HEADS] [TAILS]                           |
| Bet: [___25___]                                       |
| [PLACE BET]  Coin Flip — 2 outcomes — 1:1 payout    |
+------------------------------------------------------+
| [BACK]                              [CLOSE CHANNEL]   |
+------------------------------------------------------+
```

## Channels Tab

Channel rows with state-dependent buttons:
- OPEN: [PLAY] [PROPS] [CLOSE]
- REQUEST: [ACCEPT] [DENY]
- SENT: [CANCEL]
- New channel form inline at bottom (closes after request sent)

## Props Tab

- Propose form: text, TRUE/FALSE side, stakes, odds display, PROPOSE
- Active prop: proposition text, stakes, SETTLE TRUE / SETTLE FALSE
- Incoming prop modal: ACCEPT / DECLINE
- Prop settle modal: TRUE / FALSE
- Prop result modal: outcome, cash flow, balance change

## Close Channel Modal
```
+--------------------------------------------------+
|  Close Channel with Alice                         |
|  Your balance: 125 | Their balance: 75            |
|  [CANCEL]  [UNILATERAL]  [COOPERATIVE]            |
+--------------------------------------------------+
```

## Navigation Flow

```
CASINO TAB → channel list → [PLAY] → game lobby → [PLACE BET] → GAME MODAL
PROPS TAB → channel selector → propose/active/incoming/settle
CHANNELS TAB → full list → [ACCEPT/DENY/CANCEL] → new channel form
```

## Per-Game Stats

```javascript
GAME_STATS = {
    flip:     { wins: 0, losses: 0, profit: Decimal(0) },
    dice:     { wins: 0, losses: 0, profit: Decimal(0) },
    roulette: { wins: 0, losses: 0, profit: Decimal(0) }
};
```

Displayed as: `FLIP 3W/2L | DICE 1W/4L | ROULETTE 0W/0L`

## Colors

Midnight #080c18, Gold #f5a623, Hot Gold #ffd700, Cyan #00e5ff, 
Pink #ff2d78, Neon Green #00e676, Ghost #8892b0, White #e6f1ff

## Fonts

Orbitron (headings/amounts), Chakra Petch (body), JetBrains Mono (numbers/logs)
