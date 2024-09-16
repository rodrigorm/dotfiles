SHELL := /bin/bash

.PHONY : image test prune

image:
	docker build -t dotfiles:latest .

test: image
	docker run --rm -it dotfiles:latest sh -c "cd ~/.dotfiles && comtrya -vvv apply && cd ~ && bash"

prune:
	docker system prune -f
