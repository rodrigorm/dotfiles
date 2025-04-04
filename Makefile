SHELL := /bin/bash

SHELLCHECK_FILES := $(shell find home/.bashrc.d -type f -name "*.sh")

.PHONY : image test prune shellcheck

image:
	docker build -t dotfiles:latest .

test: image
	docker run --rm -it dotfiles:latest sh -c "cd ~/.dotfiles && comtrya -vvv apply && cd ~ && bash"

prune:
	docker system prune -f

benchmark:
	__bashrc_bench=1 bash -i

shellcheck:
	shellcheck $(SHELLCHECK_FILES) bootstrap.sh
