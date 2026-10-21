package breakdown

// Share is how much of a task someone is meant to take, in boxes (0: unknown).
type Share struct {
	UserID string `json:"userId"`
	Boxes  int    `json:"boxes"`
}

// Assign proposes an owner for each piece so that everyone ends up near their
// share: largest pieces first, each to whoever has the most room left. taken
// is work already on each person (pieces kept from before). Without shares,
// people are filled evenly. The result is in the order of subs.
func Assign(subs []Sub, shares []Share, taken map[string]int) []string {
	out := make([]string, len(subs))
	if len(shares) == 0 {
		return out
	}
	total := 0
	for _, s := range subs {
		total += s.Boxes
	}
	for _, b := range taken {
		total += b
	}
	known := 0
	for _, s := range shares {
		known += s.Boxes
	}
	target := make([]int, len(shares))
	got := make([]int, len(shares))
	for i, s := range shares {
		target[i] = s.Boxes
		if known == 0 {
			target[i] = total / len(shares)
		}
		got[i] = taken[s.UserID]
	}
	order := make([]int, len(subs))
	for i := range order {
		order[i] = i
	}
	// Stable largest-first.
	for i := 1; i < len(order); i++ {
		for j := i; j > 0 && subs[order[j]].Boxes > subs[order[j-1]].Boxes; j-- {
			order[j], order[j-1] = order[j-1], order[j]
		}
	}
	for _, k := range order {
		best := 0
		for i := 1; i < len(shares); i++ {
			if target[i]-got[i] > target[best]-got[best] {
				best = i
			}
		}
		out[k] = shares[best].UserID
		got[best] += subs[k].Boxes
	}
	return out
}
