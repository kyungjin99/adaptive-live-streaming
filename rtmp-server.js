const net = require('net');
const RtmpSession = require('./rtmp-session');

const PORT = 1935;

const server = net.createServer((socket) => {
  socket.on('end', () => {
    console.log('client exit');
  });

  const sess = new RtmpSession(socket);
  sess.run();
});

server.on('error', (error) => {
  throw error;
});

server.listen(PORT, () => {
  console.log(`RTMP Server is listening on port ${PORT}`);
});
