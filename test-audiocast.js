const MediaRendererClient = require('upnp-mediarenderer-client');

const client = new MediaRendererClient(
  'http://192.168.0.79:49152/description.xml'
);

client.load(
  'http://192.168.0.154:9001/test.mp3',
  {
    autoplay: true,
    contentType: 'audio/mpeg'
  },
  function(err, result) {
    console.log('ERR=', err);
    console.log('RESULT=', result);
  }
);
