package httpapi

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// A small model fills in deadlines nobody said, and miscounts the ones that
// were said ("이번 주 금요일" a day early). So the deadline is read from the
// words the task came from, here, and the model's date is kept only when those
// words do speak of a time this cannot read.

var (
	dueWeekday    = regexp.MustCompile(`(이번|금|다음|차|다다음)?\s*주\s*([월화수목금토일])요일|([월화수목금토일])요일`)
	dueMonthDay   = regexp.MustCompile(`(\d{1,2})\s*월\s*(\d{1,2})\s*일|(\d{1,2})/(\d{1,2})`)
	dueDayOnly    = regexp.MustCompile(`(\d{1,2})\s*일\s*(까지|에|전)`)
	dueWithin     = regexp.MustCompile(`(\d{1,2})\s*일\s*(안에|이내|내로)`)
	dueMonthEnd   = regexp.MustCompile(`(이번|이|다음)\s*달\s*(말|안|중)|월말`)
	dueWeekEnd    = regexp.MustCompile(`(이번|금|다음|차)\s*주\s*(안에|까지|중|내로)`)
	dueRelativeBy = regexp.MustCompile(`(오늘|내일|모레)\s*까지`)
	dueRelative   = regexp.MustCompile(`오늘\s*(까지|중|안에|내로)|내일|모레`)
	dueTimeSpoken = regexp.MustCompile(`(이번|다음|금|차)\s*주|주\s*(안에|내로|중에)|(이번|다음|이)\s*달|연말|분기|중순|월\s*(초|말)|\d+\s*(일|주|달|개월|시)`)
)

var koWeekday = map[string]time.Weekday{"일": time.Sunday, "월": time.Monday, "화": time.Tuesday, "수": time.Wednesday, "목": time.Thursday, "금": time.Friday, "토": time.Saturday}

// weekOffset is how many weeks after the meeting's week "이번 주", "다음 주"... is.
func weekOffset(word string) int {
	switch word {
	case "다음", "차":
		return 1
	case "다다음":
		return 2
	}
	return 0
}

// mondayOf is the Monday of the week (Monday to Sunday) day is in.
func mondayOf(day time.Time) time.Time {
	return day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
}

// spokenDue reads a deadline from what was said at a meeting held on heldOn:
// the date, and whether the words spoke of a time at all.
func spokenDue(said string, heldOn time.Time) (date string, spoken bool) {
	d := heldOn
	at := func(t time.Time) (string, bool) { return t.Format("2006-01-02"), true }
	// "내일까지 잡을게요. 다음 주 화요일이 좋겠어요": the day it is due by comes first.
	switch r := dueRelativeBy.FindStringSubmatch(said); {
	case r == nil:
	case r[1] == "오늘":
		return at(d)
	case r[1] == "내일":
		return at(d.AddDate(0, 0, 1))
	case r[1] == "모레":
		return at(d.AddDate(0, 0, 2))
	}
	if m := dueMonthDay.FindStringSubmatch(said); m != nil {
		mo, _ := strconv.Atoi(m[1] + m[3])
		day, _ := strconv.Atoi(m[2] + m[4])
		if mo >= 1 && mo <= 12 && day >= 1 && day <= 31 {
			t := time.Date(d.Year(), time.Month(mo), day, 0, 0, 0, 0, time.UTC)
			if t.Month() != time.Month(mo) {
				return "", true // 2월 30일
			}
			if t.Before(d.AddDate(0, -1, 0)) { // in December, "1월 5일" is next year's
				t = t.AddDate(1, 0, 0)
			}
			return at(t)
		}
	}
	if m := dueWeekday.FindStringSubmatch(said); m != nil {
		if m[2] != "" {
			return at(mondayOf(d).AddDate(0, 0, 7*weekOffset(m[1])+(int(koWeekday[m[2]])+6)%7))
		}
		// A bare "금요일까지" is the next one to come.
		ahead := (int(koWeekday[m[3]]) - int(d.Weekday()) + 7) % 7
		if ahead == 0 {
			ahead = 7
		}
		return at(d.AddDate(0, 0, ahead))
	}
	if m := dueWeekEnd.FindStringSubmatch(said); m != nil {
		return at(mondayOf(d).AddDate(0, 0, 7*weekOffset(m[1])+4)) // by Friday
	}
	if m := dueMonthEnd.FindStringSubmatch(said); m != nil {
		months := 1
		if m[1] == "다음" {
			months = 2
		}
		return at(time.Date(d.Year(), d.Month()+time.Month(months), 0, 0, 0, 0, 0, time.UTC))
	}
	if m := dueWithin.FindStringSubmatch(said); m != nil {
		n, _ := strconv.Atoi(m[1])
		return at(d.AddDate(0, 0, n))
	}
	if m := dueDayOnly.FindStringSubmatch(said); m != nil {
		day, _ := strconv.Atoi(m[1])
		if day >= 1 && day <= 31 {
			t := time.Date(d.Year(), d.Month(), day, 0, 0, 0, 0, time.UTC)
			if t.Before(d) {
				t = time.Date(d.Year(), d.Month()+1, day, 0, 0, 0, 0, time.UTC)
			}
			if t.Day() == day {
				return at(t)
			}
		}
	}
	switch r := dueRelative.FindString(said); {
	case strings.HasPrefix(r, "오늘"): // not "오늘은 ~를 이야기해요"
		return at(d)
	case r == "내일":
		return at(d.AddDate(0, 0, 1))
	case r == "모레":
		return at(d.AddDate(0, 0, 2))
	}
	return "", dueTimeSpoken.MatchString(strings.TrimSpace(said))
}

// taskDue is a task's deadline: read from its evidence, else the model's date
// when the evidence speaks of a time this cannot read, else none.
func taskDue(evidence, modelDate, heldOn string) *string {
	if evidence == "" {
		return nil
	}
	held, err := time.Parse("2006-01-02", heldOn)
	if err != nil {
		return nil
	}
	date, spoken := spokenDue(evidence, held)
	if date == "" && spoken && isDate(modelDate) {
		date = modelDate
	}
	if date == "" {
		return nil
	}
	return &date
}
