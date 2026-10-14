FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# Node is needed only for Claude Code, which the default AI provider runs as
# `claude -p` with the user's subscription token.
FROM node:22-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.296
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
ENV DISABLE_AUTOUPDATER=1
COPY --from=build /out/api /usr/local/bin/api
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
