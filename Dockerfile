FROM mcr.microsoft.com/devcontainers/base:ubuntu

RUN yes | unminimize

RUN apt update && apt install -y \
  curl \
  build-essential \
  sudo \
  && rm -rf /var/lib/apt/lists/*

USER vscode

RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

ENV SHELL=/bin/bash TERM=xterm-256color
SHELL [ "bash" ]
