FROM ubuntu:24.04

RUN yes | unminimize

RUN apt update && apt install -y \
  curl \
  build-essential \
  adduser \
  sudo \
  git \
  && rm -rf /var/lib/apt/lists/*

RUN echo "ubuntu:ubuntu" | chpasswd && adduser ubuntu sudo
RUN echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

USER ubuntu

RUN /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
ENV PATH="/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

WORKDIR /home/ubuntu/

ENV SHELL=/bin/bash TERM=xterm-256color
SHELL [ "bash" ]
