{
  description = "Lua-Code API and web client";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  inputs.lua-sandbox.url = "path:../Lua-5.4-Sandbox";
  inputs.lua-sandbox.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { self, nixpkgs, lua-sandbox }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs:
        let
          luacode = pkgs.callPackage ./package.nix { };
        in
        {
          inherit luacode;
          default = luacode;
          frontend = luacode.frontend;
        });

      bundlers = forAllSystems (pkgs: {
        docker = luacode: pkgs.callPackage ./docker.nix { inherit luacode; };
      });

      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.luacode;
          pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        in
        {
          imports = [ lua-sandbox.nixosModules.default ];

          options.services.luacode = {
            enable = lib.mkEnableOption "Lua-Code API";

            environmentFile = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = ''
                Environment file. Expected keys match .env.example:
                MONGODB_URI MONGODB_DB JWT_SECRET JWT_EXPIRES
                SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS EMAIL_FROM
                APP_URL FRONTEND_URL.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            services.lua-sandbox.enable = true;

            systemd.services.luacode = {
              description = "Lua-Code API and web client";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" "lua-sandbox.service" ];
              requires = [ "lua-sandbox.service" ];
              environment = {
                NODE_ENV = "production";
                LUA_WORKER_URL = "http://${config.services.lua-sandbox.bind}";
                FRONTEND_DIR = "${pkg}/frontend";
              };
              serviceConfig = {
                ExecStart = "${pkg.nodejs}/bin/node server.js";
                WorkingDirectory = pkg;
                DynamicUser = true;
                Restart = "on-failure";
              } // lib.optionalAttrs (cfg.environmentFile != null) {
                EnvironmentFile = cfg.environmentFile;
              };
            };
          };
        };
    };
}
