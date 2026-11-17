# Build on the native builder and cross-compile; no Go toolchain on the VPS host.
FROM --platform=$BUILDPLATFORM golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags='-s -w' -o /validator .
FROM scratch
COPY --from=build /validator /validator
COPY third_party/ /licenses/
USER 10001:10001
ENTRYPOINT ["/validator"]
