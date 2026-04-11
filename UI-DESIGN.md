# Thunder Casino v0.2.0 — Fruit Machine UX Design

## The Experience

When you place a bet, it should feel like pulling the handle on a high-end slot machine.
Every step of the protocol becomes a visual and audio event. The 2-3 seconds of Maxima
round-trip become ANTICIPATION, not waiting.

## Game Flow — What The Player Sees

### IDLE STATE
- Game selector (flip/dice/roulette) glowing softly
- Pick grid pulsing gently, inviting selection
- Balance displayed prominently in gold Orbitron font
- Ambient low hum (subtle, barely audible)

### PICK SELECTED
- Selected number lights up gold with glow
- Satisfying "chip click" sound
- Bet input focuses, cursor blinks in gold

### PLACE BET CLICKED
- Button does a press-down animation (3D feel)
- "KA-CHUNK" lever pull sound
- Screen shakes subtly (2px, 100ms)
- All pick buttons dim except selected one
- Result display shows spinning animation:

### PHASE 1: "FINDING HOUSE..." (0-2 seconds)
- Three dots animate (...) in the result area
- Subtle pulsing glow on the game area border
- Low rumble building sound

### PHASE 2: "BET LOCKED" (when GAME_BET_SIGNED received)
- Gold flash across the screen (CSS animation)
- "LOCKED" text appears briefly with lock icon
- "CHA-CHING" register sound
- Balance flashes to show deduction (pessimistic)
- The bet amount appears floating above, then drops into the "pot"

### PHASE 3: "REVEALING..." (when waiting for house secret)
- The result display starts SPINNING:
  - COIN FLIP: Coin rotates on Y axis rapidly
  - DICE: Die tumbles with changing faces
  - ROULETTE: Numbers scroll rapidly like a slot reel
- Spinning sound (whoosh for coin, rattle for dice, clicks for roulette)
- Speed gradually decreases (deceleration curve)
- Tension-building ascending tone

### PHASE 4: RESULT REVEAL (when outcome computed)
- Animation STOPS on the result:
  - COIN: Lands on heads/tails with a BOUNCE
  - DICE: Settles on face with a THUD
  - ROULETTE: Last few numbers tick slowly... slower... STOP
- 500ms PAUSE (the moment of truth)

### PHASE 5: WIN or LOSE
- **WIN:**
  - Result number EXPLODES green
  - Particles/confetti burst from center
  - "YOU WIN!" text scales up with bounce
  - Win amount "+25.00" flies up in green
  - Triumphant ascending arpeggio (C-E-G-C)
  - Balance updates with green flash
  - Screen border pulses green 3 times
  
- **LOSE:**
  - Result number fades to pink/red
  - Brief shake animation
  - "LOSE" text appears (smaller, muted)
  - Descending tone (wah-wah)
  - Balance updates with brief red flash
  - Quick, doesn't dwell — ready for next bet

### PHASE 6: READY FOR NEXT
- After 2 seconds, UI resets
- Pick grid re-enables
- "PLACE BET" button re-enables with a glow
- Previous result shown small in the round history pips
- Subtle "ready" chime

## Sound Design (Web Audio API — no external files)

All sounds synthesized in JavaScript. No audio files needed.

### Sounds:
1. **chip_click** — Short high click (800Hz square, 50ms, fast decay)
2. **lever_pull** — Low mechanical chunk (200Hz + noise, 200ms)
3. **lock_cash** — Register cha-ching (1200Hz + 1500Hz, 100ms, bright)
4. **spin_whoosh** — Bandpass noise with LFO (continuous, speed varies)
5. **spin_tick** — Short click (2000Hz, 20ms) — for roulette ticks
6. **dice_rattle** — Noise bursts (50ms each, random pitch)
7. **coin_flip** — Whooshing air (bandpass noise, 5Hz amplitude mod)
8. **result_thud** — Low impact (80Hz, 100ms, heavy envelope)
9. **win_fanfare** — Rising arpeggio (523→659→784→1047Hz, square wave)
10. **lose_wah** — Descending slide (400→120Hz, sawtooth, 500ms)
11. **ambient_hum** — Very low drone (60Hz sine, barely audible)
12. **ready_chime** — Gentle bell (880Hz, triangle, 200ms, soft)

### Sound Toggle
- SND button in header (speaker icon)
- Muted by default on first load
- State saved in MDS.keypair

## Animations (CSS + JS)

### Coin Flip Animation
```
.coin-spinning {
  animation: coinSpin 2s cubic-bezier(0.17, 0.67, 0.21, 0.99);
}
@keyframes coinSpin {
  0%   { transform: rotateY(0deg); }
  80%  { transform: rotateY(2880deg); } /* 8 full rotations */
  90%  { transform: rotateY(3060deg); } /* slowing */
  100% { transform: rotateY(3240deg); } /* final: heads=0, tails=180 offset */
}
```
Two-sided coin: gold face (Heads) and silver face (Tails)
Final rotation lands on the correct side based on result.

### Dice Roll Animation
```
Display a 3D-ish die face that changes rapidly then settles.
Use a series of die face SVGs/CSS (dots pattern).
Rapid switching (50ms intervals) → slow to 200ms → 500ms → stop.
```

### Roulette Scroll Animation
```
A vertical strip of numbers scrolling upward, decelerating.
Like a slot machine reel.
Numbers are colored (alternating gold/white).
The winning number settles in the center with a highlight.
```

### Win Particles
```
20-30 small circles (gold, green, white) explode from center.
Each has random velocity + gravity.
Fade out over 1.5 seconds.
Pure CSS animations with JS-generated elements.
```

### Screen Flash
```
A full-width overlay that flashes gold (win) or red (lose).
Opacity: 0 → 0.3 → 0 over 300ms.
```

## UI States Map

| State | Result Display | Buttons | Balance | Sound |
|-------|---------------|---------|---------|-------|
| Idle | "?" pulsing | Pick enabled, Bet enabled | Normal gold | Ambient |
| Pick selected | "?" | Selected glows, Bet enabled | Normal | chip_click |
| Bet placed | Spinning anim | All disabled | Normal | lever_pull |
| Bet locked | Brief "LOCKED" | All disabled | Deducted (flash) | lock_cash |
| Revealing | Spinning (decel) | All disabled | Deducted | spin sound |
| Result shown | Number (big) | All disabled | Deducted | result_thud |
| Win | Number (green) | All disabled | Updated (green) | win_fanfare |
| Lose | Number (red) | All disabled | Updated (red flash) | lose_wah |
| Ready | "?" pulsing | Re-enabled | Updated | ready_chime |

## Implementation Plan

1. Build the SFX engine (Web Audio API synthesizer)
2. Build the animation components (coin, dice, roulette reel)
3. Build the particle system
4. Wire up the game state machine to trigger animations/sounds
5. Add the progress indicators for each protocol step
6. Test the full flow with real games
7. Polish timing and feel
