# mogwai-db — a Bun-compiled standalone server (glibc-only: the binary links just libc/libm/libpthread,
# no libstdc++) on a minimal Debian base. Multi-arch: buildx sets TARGETARCH (amd64 | arm64) and the
# matching prebuilt binary from the release is copied in — no build toolchain in the image, no RUN steps
# (so a cross-arch build needs no emulation).
#
# The build CONTEXT must contain `mogwai-db-amd64` and `mogwai-db-arm64` (the release's linux-x64 /
# linux-arm64 binaries, renamed to Docker's arch names). See the `docker` job in .github/workflows/ci.yml.
FROM debian:bookworm-slim
ARG TARGETARCH
COPY --chmod=755 mogwai-db-${TARGETARCH} /usr/local/bin/mogwai-db
# Per-graph SQLite files live here and persist on the volume; the server creates the dir on start
# (BunGraphManager mkdirs its data dir). Override with --data-dir or MOGWAI_DB_DIR. io() is opt-in
# (mount a dir and set MOGWAI_IO_DIR / --io-dir).
ENV MOGWAI_DB_DIR=/data
VOLUME /data
EXPOSE 8182
ENTRYPOINT ["mogwai-db"]
