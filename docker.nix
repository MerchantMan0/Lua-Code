# Compiles the Lua-Code package into a Docker image archive.
{
  dockerTools,
  cacert,
  luacode,
}:

dockerTools.streamLayeredImage {
  name = "luacode";
  tag = luacode.version;
  contents = [
    luacode
    luacode.nodejs
    cacert
  ];
  extraCommands = "mkdir -p tmp";
  config = {
    Cmd = [ "${luacode.nodejs}/bin/node" "server.js" ];
    WorkingDir = "${luacode}";
    Env = [
      "NODE_ENV=production"
      "FRONTEND_DIR=${luacode}/frontend"
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
    ];
    ExposedPorts = { "5000/tcp" = { }; };
  };
}
