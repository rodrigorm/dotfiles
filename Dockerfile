FROM rust as builder

RUN cargo install comtrya

FROM ubuntu

RUN yes | unminimize

RUN apt update && apt install -y \
  adduser \
  sudo \
  && rm -rf /var/lib/apt/lists/*

RUN echo "ubuntu:ubuntu" | chpasswd && adduser ubuntu sudo

COPY --from=builder /usr/local/cargo/bin/comtrya /usr/local/bin/comtrya

COPY . /home/ubuntu/.dotfiles
RUN chown -R ubuntu:ubuntu /home/ubuntu/.dotfiles

USER ubuntu

WORKDIR /home/ubuntu/.dotfiles

ENV SHELL=/bin/bash TERM=xterm-256color
SHELL [ "bash" ]