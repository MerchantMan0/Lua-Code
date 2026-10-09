{
  lib,
  buildNpmPackage,
  nodejs,
  nodejs_22,
}:

let
  version = "1.0.0";

  frontend = buildNpmPackage.override { nodejs = nodejs_22; } {
    pname = "luacode-frontend";
    inherit version;

    src = lib.fileset.toSource {
      root = ./frontend;
      fileset = lib.fileset.unions [
        ./frontend/package.json
        ./frontend/package-lock.json
        ./frontend/public
        ./frontend/src
      ];
    };

    npmDepsHash = "sha256-GwF0UFWJjc6WU919+IEuER701il9rZc+PRZCy97yjxw=";

    env.CI = "false";
    env.GENERATE_SOURCEMAP = "false";

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp -R build/. $out/
      runHook postInstall
    '';

    meta = {
      description = "Lua-Code web client";
      license = lib.licenses.isc;
    };
  };
in
buildNpmPackage {
  pname = "luacode";
  inherit version;

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./server.js
      ./lib
    ];
  };

  npmDepsHash = "sha256-ZuKpBoAhMvrtsdwlPyuLhuI8Y0Red0Kva6SVimltc7A=";

  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/frontend
    cp -a server.js lib package.json node_modules $out/
    cp -a ${frontend}/. $out/frontend/
    runHook postInstall
  '';

  passthru = {
    inherit frontend nodejs;
  };

  meta = {
    description = "Lua-Code API and web client";
    license = lib.licenses.isc;
  };
}
