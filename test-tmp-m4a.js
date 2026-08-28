const C=require('upnp-mediarenderer-client');
const c=new C('http://192.168.0.79:49152/description.xml');

c.load(
  'http://192.168.0.154:9002/upnptube-test.m4a',
  { autoplay: true, contentType: 'audio/mp4' },
  (e,r)=>console.log('ERR=',e,'RESULT=',r)
);
