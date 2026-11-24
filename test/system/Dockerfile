# The throwaway system for test/system. `run.sh` mounts the host's `bun`, `opencode` and the repository.
FROM ubuntu:24.04
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends ca-certificates git procps >/dev/null \
  && rm -rf /var/lib/apt/lists/*
