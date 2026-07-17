This is the birthday paradox, and here's the mechanism your rule missed:

Your model priced a collision as "my new draw hits one specific occupied slot" — probability n/D after n draws, so you need n ≈ D for it to be likely. But a collision is "my new draw hits any of the n already-drawn IDs, for every draw along the way." What accumulates isn't draws — it's pairs:

┌───────────────┬───────────────────────────────┐
│ after n draws │ pairs that could match ≈ n²/2 │
├───────────────┼───────────────────────────────┤
│ 1,000         │ 500 thousand                  │
├───────────────┼───────────────────────────────┤
│ 35,000        │ ~612 million                  │
├───────────────┼───────────────────────────────┤
│ 1,000,000     │ 500 billion                   │
└───────────────┴───────────────────────────────┘

Each pair matches with probability 1/D. So the expected number of collisions after n draws is ≈ n²/2D — and that hits 1 not when n ≈ D, but when n ≈ √(2D). Collision risk grows with the square of what you've issued. For D = 916M: √(2D) ≈ 43k, and the exact expected first collision is √(π/2·D) ≈ 37,900 — your nine trials averaged ~35,000, dead on the math.

The one-line rule to keep: first collision arrives at ≈ 1.25·√D — the square root of the keyspace, not the keyspace. 62⁷'s "3.5 trillion IDs" is really "~2 million IDs before your first collision" — which is why nobody ships random short IDs without a collision check.

Now apply the corrected rule yourself — revised predictions on record for 6-char (D = 5.68×10¹⁰) and 7-char (D = 3.52×10¹²), then run:

node idlab.js birthday --chars 6
node idlab.js birthday --chars 7