SHELL := /bin/bash

.PHONY : image test prune

image:
	docker build -t dotfiles:latest .

test: image
	docker run --rm -it dotfiles:latest sh -c "comtrya -vvv apply && bash"

prune:
	docker system prune -f