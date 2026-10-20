// Package secretbox seals small secrets (users' API keys) with AES-256-GCM
// under one server key, so the database alone cannot reveal them.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
)

var ErrNoKey = errors.New("AI_SECRET_KEY is not set (64 hex characters)")

type Box struct{ aead cipher.AEAD }

// New takes the key as 64 hex characters; an empty key gives a nil Box.
func New(hexKey string) (*Box, error) {
	if hexKey == "" {
		return nil, nil
	}
	key, err := hex.DecodeString(hexKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("AI_SECRET_KEY must be 64 hex characters (32 bytes)")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

// Seal returns nonce || ciphertext. ad binds the secret to its row (the connection id).
func (b *Box) Seal(plain, ad []byte) ([]byte, error) {
	if b == nil {
		return nil, ErrNoKey
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plain, ad), nil
}

func (b *Box) Open(sealed, ad []byte) ([]byte, error) {
	if b == nil {
		return nil, ErrNoKey
	}
	n := b.aead.NonceSize()
	if len(sealed) < n {
		return nil, errors.New("sealed value too short")
	}
	return b.aead.Open(nil, sealed[:n], sealed[n:], ad)
}
