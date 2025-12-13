SHELL := /bin/bash

SHELLCHECK_FILES := $(shell find home/.bashrc.d -type f -name "*.sh")

.PHONY : image test shell prune benchmark shellcheck

image:
	docker build -t dotfiles:latest .

test: image
	docker run --rm -v $(PWD):/workspaces/dotfiles dotfiles:latest sh -c "cd /workspaces/dotfiles && ./bootstrap.sh && ./test.sh"

shell: image
	docker run --rm -it -v $(PWD):/workspaces/dotfiles dotfiles:latest sh -c "cd /workspaces/dotfiles && ./bootstrap.sh && bash -l"

prune:
	docker system prune -f

benchmark:
	__bashrc_bench=1 bash -i

shellcheck:
	shellcheck $(SHELLCHECK_FILES) bootstrap.sh
