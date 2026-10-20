FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN for c in api admin migrate; do CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/$c ./cmd/$c || exit 1; done

# The admin server and the migration step need nothing but root certificates.
FROM debian:bookworm-slim AS admin
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/admin /usr/local/bin/admin
COPY --from=build /out/migrate /usr/local/bin/migrate
USER nobody
EXPOSE 8090
ENTRYPOINT ["/usr/local/bin/admin"]

# The app server. Node is needed only for Claude Code, which the default AI
# provider runs as `claude -p` with the owner's subscription token.
FROM node:22-bookworm-slim AS service
# Root certificates for the Go server's own HTTPS calls (Google sign-in, Anthropic API);
# the slim image has none, and Node only carries its own bundle.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ARG CLAUDE_CODE_VERSION=2.1.296
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1
COPY --from=build /out/api /usr/local/bin/api
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
