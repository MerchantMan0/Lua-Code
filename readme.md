
Lua-Code is a web app where you write Lua, submit it to challenges, and see the results on a leaderboard. The client is React with Monaco. The Express API stores accounts, submissions, and scores in MongoDB, and a separate Lua sandbox service runs the submitted code.

The sandbox is in a separate repository linked here.
https://github.com/MerchantMan0/Lua-5.4-Sandbox

# Deployment
While this can be deployed manually by configuring the starting the API and the sandbox service, we support nix and docker and advise either. The docker image is built using the docker.nix nix file.

To download and run the docker image please run these commands
```bash
docker pull ghcr.io/merchantman0/luacode:1.0.0
docker run --env-file .env -p 5000:5000 ghcr.io/merchantman0/luacode:1.0.0
```

If you are using nix instead, add the flake input and enable the module.