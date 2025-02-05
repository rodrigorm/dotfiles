# dotfiles

In Unix, configuration files are king. This is my castle.

## Installation

### Install External Dependencies

- [Homebrew](https://brew.sh/)
  ```
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```
- [Comtrya](https://comtrya.dev/)

### Install dotfiles

```bash
$ git clone https://github.com/rodrigorm/dotfiles.git $HOME/.dotfiles
$ cd $HOME/.dotfiles
$ comtrya apply
$ vim +BundleInstall +qall
```

OS X 10.7 Lion: Double click to install or import Solarized Dark.terminal into Terminal.app preferences.

OS X 10.8 Mountain Lion: Import Solarized Dark.terminal into Terminal.app preferences.

## License

Copyright (C) 2014 Rodrigo Moyle <rodrigorm@gmail.com>

This program is free software: you can redistribute it and/or modify
it under the terms of the Lesser GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the Lesser GNU General Public License
along with this program. If not, see http://www.gnu.org/licenses/.
