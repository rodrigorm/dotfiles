# dotfiles

In Unix, configuration files are king. This is my castle.

## Installation

### Install External Dependencies

- [Homebrew](https://brew.sh/)
  ```
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```

### Install dotfiles

```bash
$ git clone https://github.com/rodrigorm/dotfiles.git $HOME/.dotfiles
$ cd $HOME/.dotfiles
$ ./bootstrap.sh
```

OS X 10.7 Lion: Double click to install or import Solarized Dark.terminal into Terminal.app preferences.

OS X 10.8 Mountain Lion: Import Solarized Dark.terminal into Terminal.app preferences.

## OpenCode server

Run `oc` to start or reuse one OpenCode server on `http://127.0.0.1:4096` and
publish it through Tailscale Serve. Point T3's OpenCode **Server URL** at that
local address to share the server across chat sessions.

On macOS, `oc` idempotently installs
`~/Library/LaunchAgents/com.rodrigorm.opencode.4096.plist`. The LaunchAgent starts
OpenCode at login and restarts it if it exits. Running `oc` again reuses the
healthy server. `oc --force` restarts the managed server and recreates its
compatible Tailscale route.

If a server was already started outside launchd, `oc` installs the agent but
keeps that server running until the next login. Use `oc --force` to migrate it
immediately, interrupting its current requests. Changes to a loaded agent's
settings also take effect at the next login or with `oc --force`.

OpenCode starts in `$HOME`; clients choose their project with
`opencode attach http://127.0.0.1:4096 --dir /path/to/project`. Logs are kept in
`~/.local/state/oc/4096/opencode.log`. Set `PORT` to manage a separate instance;
each port gets its own agent and operational state. The LaunchAgent preserves
`HOME`, `PATH`, `XDG_*_HOME`, and `OPENCODE_*` environment settings at installation
and keeps its plist private.

On Linux, `oc` continues to start the background server with `nohup`. Run
`oc --help` for dependency paths, state directories, and timeout overrides.

## Development

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
