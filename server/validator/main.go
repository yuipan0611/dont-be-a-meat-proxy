package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--healthcheck" {
		c := &http.Client{Timeout: 2 * time.Second}
		r, e := c.Get("http://127.0.0.1:8766/health/liveness")
		if e != nil {
			os.Exit(1)
		}
		r.Body.Close()
		if r.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	h, err := newValidator(env("VALIDATOR_UPSTREAM", "http://mail-a:8765"), env("VALIDATOR_ALLOWLIST", "/run/private/validator-allowlist.json"))
	if err != nil {
		log.Print("validator configuration unavailable; no traffic accepted")
		os.Exit(1)
	}
	s := &http.Server{Addr: env("VALIDATOR_LISTEN", ":8766"), Handler: h, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32768, ErrorLog: log.New(io.Discard, "", 0)}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		s.Shutdown(c)
	}()
	log.Print("validator ready; gitleaks=v8.30.1; content logging disabled")
	if err = s.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print("validator listener failed")
		os.Exit(1)
	}
}
