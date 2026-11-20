package twittermeow

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-twitter/pkg/twittermeow/cookies"
)

func TestNodeXSOCKS5(t *testing.T) {
	var originHits atomic.Int32
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		originHits.Add(1)
		if r.URL.Path != "/live" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err == nil {
			defer conn.CloseNow()
			_ = conn.Write(r.Context(), websocket.MessageText, []byte("fixture"))
		}
	}))
	defer origin.Close()
	target := origin.Listener.Addr().String()
	websocketURL := "ws" + strings.TrimPrefix(origin.URL, "http") + "/live"

	aliceProxy, aliceHits, closeAlice := nodeXProxy(t, target, "alice")
	bobProxy, bobHits, closeBob := nodeXProxy(t, target, "bob")
	defer closeAlice()
	defer closeBob()
	alice := NewClient(cookies.NewCookies(nil), nil, zerolog.Nop())
	bob := NewClient(cookies.NewCookies(nil), nil, zerolog.Nop())

	request := func(client *Client) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin.URL, nil)
		if err != nil {
			return err
		}
		response, err := client.HTTP.Do(req)
		if err == nil {
			response.Body.Close()
			if response.StatusCode != http.StatusNoContent {
				return errors.New("unexpected HTTP fixture status")
			}
		}
		return err
	}
	connect := func(client *Client) error {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn, _, err := websocket.Dial(ctx, websocketURL, &websocket.DialOptions{HTTPClient: client.websocketHTTP})
		if err != nil {
			return err
		}
		defer conn.CloseNow()
		_, message, err := conn.Read(ctx)
		if err == nil && string(message) != "fixture" {
			return errors.New("unexpected WebSocket fixture message")
		}
		return err
	}

	t.Run("reject requests before proxy is ready", func(t *testing.T) {
		alice.RequireProxy()
		bob.RequireProxy()
		for _, attempt := range []func(*Client) error{request, connect} {
			if err := attempt(alice); !errors.Is(err, ErrProxyNotSet) {
				t.Fatalf("expected ErrProxyNotSet, got %v", err)
			}
		}
		if hits := originHits.Load(); hits != 0 {
			t.Fatalf("origin received %d requests without a proxy", hits)
		}
	})

	t.Run("keep accounts on separate authenticated proxies", func(t *testing.T) {
		if err := alice.SetProxy(aliceProxy); err != nil {
			t.Fatal(err)
		}
		if err := bob.SetProxy(bobProxy); err != nil {
			t.Fatal(err)
		}
		for _, client := range []*Client{alice, bob} {
			if err := request(client); err != nil {
				t.Fatal(err)
			}
			if err := connect(client); err != nil {
				t.Fatal(err)
			}
		}
		if a, b := aliceHits.Load(), bobHits.Load(); a != 2 || b != 2 {
			t.Fatalf("expected one HTTP and one WebSocket tunnel per proxy, got %d and %d", a, b)
		}
		if hits := originHits.Load(); hits != 4 {
			t.Fatalf("expected four requests through the proxies, got %d", hits)
		}
	})

	t.Run("proxy outage cannot fall back to direct or another account", func(t *testing.T) {
		closeAlice()
		alice.HTTP.CloseIdleConnections()
		alice.websocketHTTP.CloseIdleConnections()
		for _, attempt := range []func(*Client) error{request, connect} {
			if err := attempt(alice); err == nil {
				t.Fatal("request succeeded after its proxy stopped")
			}
		}
		if originHits.Load() != 4 || bobHits.Load() != 2 {
			t.Fatal("Alice used direct access or the other account's proxy")
		}
		if err := request(bob); err != nil {
			t.Fatalf("other account lost its connection: %v", err)
		}
	})

	t.Run("web proxy bridge and DM client use the same SOCKS5 binding", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		script := filepath.Join(os.Getenv("NODEX_PROBE_DIR"), "browser-bridge.mjs")
		cmd := exec.CommandContext(ctx, "node", "--import", "tsx", script, bobProxy, target)
		cmd.Dir = filepath.Dir(filepath.Dir(script))
		before := bobHits.Load()
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("Node X browser bridge failed: %v\n%s", err, out)
		}
		if bobHits.Load() != before+1 {
			t.Fatal("browser bridge did not use the same SOCKS5 binding as the DM client")
		}
	})
}

// The SOCKS5 fixture accepts one synthetic login and only forwards to the local HTTP fixture.
func nodeXProxy(t *testing.T, target, username string) (string, *atomic.Int32, func()) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(8 * time.Second))
				if !nodeXSOCKSHandshake(conn, username) {
					return
				}
				upstream, err := net.DialTimeout("tcp4", target, time.Second)
				if err != nil {
					return
				}
				defer upstream.Close()
				hits.Add(1)
				if _, err := conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0}); err != nil {
					return
				}
				go func() { _, _ = io.Copy(upstream, conn); _ = upstream.Close() }()
				_, _ = io.Copy(conn, upstream)
			}()
		}
	}()
	address := (&url.URL{Scheme: "socks5", Host: listener.Addr().String(), User: url.UserPassword(username, "fixture")}).String()
	return address, &hits, func() { _ = listener.Close() }
}

func nodeXSOCKSHandshake(conn net.Conn, username string) bool {
	read := func(size int) []byte {
		buf := make([]byte, size)
		if _, err := io.ReadFull(conn, buf); err != nil {
			return nil
		}
		return buf
	}
	method := read(2)
	if len(method) != 2 || method[0] != 5 || !bytes.Contains(read(int(method[1])), []byte{2}) {
		return false
	}
	if _, err := conn.Write([]byte{5, 2}); err != nil {
		return false
	}
	auth := read(2)
	if len(auth) != 2 || auth[0] != 1 || string(read(int(auth[1]))) != username {
		return false
	}
	size := read(1)
	if len(size) != 1 || string(read(int(size[0]))) != "fixture" {
		return false
	}
	if _, err := conn.Write([]byte{1, 0}); err != nil {
		return false
	}
	// The tests use an IPv4 loopback HTTP fixture and no DNS lookup.
	return bytes.Equal(read(4), []byte{5, 1, 0, 1}) && len(read(6)) == 6
}
