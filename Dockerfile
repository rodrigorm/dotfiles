FROM ubuntu:24.04

RUN yes | unminimize

RUN apt update && apt install -y \
  curl \
  build-essential \
  adduser \
  sudo \
  git \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

RUN cargo install comtrya --root /usr/local

RUN curl -L https://github.com/neovim/neovim/releases/download/v0.10.4/nvim-linux-arm64.tar.gz -o /tmp/nvim.tar.gz && \
    tar -xzf /tmp/nvim.tar.gz -C /tmp && \
    cp /tmp/nvim-linux-arm64/bin/nvim /usr/local/bin/ && \
    chmod +x /usr/local/bin/nvim && \
    rm -rf /tmp/nvim*

RUN useradd ubuntu --no-create-home --shell /bin/bash || true && echo "ubuntu:ubuntu" | chpasswd && usermod -aG sudo ubuntu || true

RUN echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER ubuntu

WORKDIR /home/ubuntu/

ENV SHELL=/bin/bash TERM=xterm-256color
SHELL [ "bash" ]