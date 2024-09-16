FROM rust AS builder

RUN cargo install comtrya

FROM ubuntu:22.04

RUN yes | unminimize

RUN apt update && apt install -y \
  adduser \
  sudo \
  && rm -rf /var/lib/apt/lists/*

RUN useradd ubuntu && echo "ubuntu:ubuntu" | chpasswd && adduser ubuntu sudo

COPY --from=builder /usr/local/cargo/bin/comtrya /usr/local/bin/comtrya

COPY . /home/ubuntu/.dotfiles
RUN chown -R ubuntu:ubuntu /home/ubuntu

USER ubuntu

WORKDIR /home/ubuntu/

ENV SHELL=/bin/bash TERM=xterm-256color
SHELL [ "bash" ]
