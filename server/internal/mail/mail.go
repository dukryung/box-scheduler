// Package mail sends the service's emails (team invites) over SMTP. Without
// SMTP settings nothing is sent and callers fall back to a copyable link.
package mail

import (
	"crypto/tls"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/smtp"
	"strings"
	"time"
)

var ErrNotConfigured = errors.New("메일 발송이 설정되지 않았어요")

type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// SMTP sends through one server. With User set it authenticates (PLAIN),
// which needs TLS: STARTTLS on 587/25, or implicit TLS on 465.
type SMTP struct {
	Host string
	Port string
	User string
	Pass string
	From string // "Box Scheduler <noreply@example.com>"
}

func (s *SMTP) Enabled() bool { return s != nil && s.Host != "" && s.From != "" }

func (s *SMTP) Send(m Message) error {
	if !s.Enabled() {
		return ErrNotConfigured
	}
	if strings.ContainsAny(m.To, "\r\n") || strings.ContainsAny(m.Subject, "\r\n") {
		return errors.New("bad header value")
	}
	fromAddr := s.From
	if i := strings.LastIndex(fromAddr, "<"); i >= 0 {
		fromAddr = strings.Trim(fromAddr[i:], "<>")
	}
	boundary := fmt.Sprintf("bs-%d", time.Now().UnixNano())
	var b strings.Builder
	fmt.Fprintf(&b, "From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\n",
		s.From, m.To, mime.QEncoding.Encode("utf-8", m.Subject), time.Now().Format(time.RFC1123Z))
	fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", boundary)
	fmt.Fprintf(&b, "--%s\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n%s\r\n", boundary, m.Text)
	if m.HTML != "" {
		fmt.Fprintf(&b, "--%s\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n%s\r\n", boundary, m.HTML)
	}
	fmt.Fprintf(&b, "--%s--\r\n", boundary)
	return s.deliver(fromAddr, m.To, []byte(b.String()))
}

func (s *SMTP) deliver(from, to string, msg []byte) error {
	addr := net.JoinHostPort(s.Host, s.Port)
	var c *smtp.Client
	if s.Port == "465" {
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 15 * time.Second}, "tcp", addr, &tls.Config{ServerName: s.Host})
		if err != nil {
			return err
		}
		if c, err = smtp.NewClient(conn, s.Host); err != nil {
			return err
		}
	} else {
		conn, err := net.DialTimeout("tcp", addr, 15*time.Second)
		if err != nil {
			return err
		}
		if c, err = smtp.NewClient(conn, s.Host); err != nil {
			return err
		}
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(&tls.Config{ServerName: s.Host}); err != nil {
				return err
			}
		}
	}
	defer c.Close()
	if s.User != "" {
		if err := c.Auth(smtp.PlainAuth("", s.User, s.Pass, s.Host)); err != nil {
			return err
		}
	}
	if err := c.Mail(from); err != nil {
		return err
	}
	if err := c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(msg); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}
