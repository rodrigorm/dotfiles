FROM mcr.microsoft.com/devcontainers/base:ubuntu

RUN yes | unminimize

RUN apt update && apt install -y \
  curl \
  build-essential \
  sudo \
  && rm -rf /var/lib/apt/lists/*

USER vscode

ENV SHELL=/bin/bash TERM=xterm-256color
SHELL [ "bash" ]
