const MediaRendererClient = require('upnp-mediarenderer-client');

const client = new MediaRendererClient(
  'http://192.168.0.79:49152/description.xml'
);

client.load(
  'http://192.168.0.154:9001/test.m4a',
  {
    autoplay: true,
    contentType: 'audio/mp4'
  },
  function(err, result) {
    console.log('ERR=', err);
    console.log('RESULT=', result);
  }
);
