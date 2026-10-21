package notify

import "testing"

func TestAllowedEndpoint(t *testing.T) {
	n := &Notifier{extra: map[string]bool{"host.docker.internal:3196": true}}
	for endpoint, want := range map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc":                true,
		"https://updates.push.services.mozilla.com/wpush/v2/abc": true,
		"https://web.push.apple.com/QGx":                         true,
		"https://wns2-par02p.notify.windows.com/w/?token=x":      true,
		"http://fcm.googleapis.com/fcm/send/abc":                 false, // not https
		"https://fcm.googleapis.com:8443/x":                      false,
		"https://evil.example/fcm.googleapis.com":                false,
		"https://fcm.googleapis.com.evil.example/x":              false,
		"https://pushapple.com/x":                                false,
		"http://169.254.169.254/latest":                          false,
		"http://host.docker.internal:3196/push/a":                true, // test stack only
		"http://host.docker.internal:3197/x":                     false,
		"not a url":                                              false,
	} {
		if got := n.AllowedEndpoint(endpoint); got != want {
			t.Errorf("%s: got %v, want %v", endpoint, got, want)
		}
	}
}
