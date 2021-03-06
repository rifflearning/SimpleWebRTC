var util = require('util');
var webrtcSupport = require('webrtcsupport');
var PeerConnection = require('rtcpeerconnection');
var WildEmitter = require('wildemitter');
var FileTransfer = require('filetransfer');
// sdputils is required for the sdp modification
// it is found here: https://github.com/webrtc/apprtc/blob/master/src/web_app/js/sdputils.js
// I have temporarily removed it from this repo because we're not actively using it
// at the moment and I didn't want to have to deal with the licensing stuff
// -jr 8.6.19
// var sdputils = require('./sdputils');

// the inband-v1 protocol is sending metadata inband in a serialized JSON object
// followed by the actual data. Receiver closes the datachannel upon completion
var INBAND_FILETRANSFER_V1 = 'https://simplewebrtc.com/protocol/filetransfer#inband-v1';

function isAllTracksEnded(stream) {
    let isAllTracksEnded = true;
    stream.getTracks().forEach(function (t) {
        isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded;
    });
    return isAllTracksEnded;
}

// takes an mLine, modifies it to put the given
// codec ID at the front of the list
function setDefaultCodec(mLine, id) {
    // m line example format:
    // m=video 60372 UDP/TLS/RTP/SAVPF 100 101 116 117 96
    let elements = mLine.split(' ');
    let newLine = [];
    let index = 0;
    for (let i = 0; i < elements.length; i++) {
        if (index === 3) {
            newLine[index++] = id;
        }
        if (elements[i] !== id || index < 3) {
            newLine[index++] = elements[i];
        }
    }
    return newLine.join(' ');
}

/** adds b=as <bitrate> to the sdp */
function setBitrate(sdp, mediaType, bitrate) {
    const sdpLines = sdp.split('\r\n');
    let mLineIndex = null;
    // find the m line matching our mediatype, so we can make sure
    // we're modifying the correct section
    for (let i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('m=' + mediaType) !== -1) {
            mLineIndex = i;
            break;
        }
    }

    if (mLineIndex === null) {
        // if there's no m line, we've been given a broken SDP
        // just abort and send it back
        return sdp;
    }

    let index = mLineIndex + 1;
    // we need to find the correct spot to insert the b= line.
    // per RFC 4566 (https://tools.ietf.org/html/rfc4566),
    // b= line must follow c= line (if it exists)
    // c= line (if it exists) follows i= line (if it exists),
    // i= line (if it exists) follows m= line
    // ex:
    // m=mediaType etc
    // i=etc (optional)
    // c=etc (optional)
    // b=etc
    while (sdpLines[index].startsWith('i=') || sdpLines[index].startsWith('c=')) {
        index++;
    }

    if (sdpLines[index].startsWith('b=AS')) {
        // bitrate limit already specified
        return sdp;
    }
    sdpLines.splice(index, 0, 'b=AS:' + bitrate);
    return sdpLines.join('\r\n');
}

/**
 * take an SDP and modify it to prefer
 * the given encoding
 * must match string expected in SDP
 */
function preferCodec(sdp, mediaType, codec) {
    const sdpLines = sdp.split('\r\n');
    // find this so we can modify it later
    let mLineIndex = null;
    // it's possible to have more than one ID for
    // a single codec, but i'm not sure why
    // keeping track of all of them, even if we only
    // use the first one for now
    let codexLineIndices = [];
    for (let i = 0; i < sdpLines.length; i++) {
        if (sdpLines[i].search('m=' + mediaType) !== -1) {
            mLineIndex = i;
        }
        if (sdpLines[i].search(codec) !== -1) {
            codexLineIndices.push(i);
        }
    }

    let codexLineIds = [];
    // example codex line format:
    // a=rtpmap:126 H264/90000
    // we want the `126` portion of it
    for (let i = 0; i < codexLineIndices.length; i++) {
        const codexLine = sdpLines[codexLineIndices[i]];
        // grab the slice starting after the `:` and before the ` `
        const sliceStart = codexLine.indexOf(':') + 1;
        const sliceEnd = codexLine.indexOf(' ');
        codexLineIds.push(codexLine.slice(sliceStart, sliceEnd));
    }

    const mLine = sdpLines[mLineIndex];
    sdpLines[mLineIndex] = setDefaultCodec(mLine, codexLineIds[0]);
    return sdpLines.join('\r\n');
}

function Peer(options) {
    var self = this;

    // call emitter constructor
    WildEmitter.call(this);

    this.id = options.id;
    this.parent = options.parent;
    this.type = options.type || 'video';
    this.oneway = options.oneway || false;
    this.sharemyscreen = options.sharemyscreen || false;
    this.browserPrefix = options.prefix;
    this.stream = options.stream;
    this.enableDataChannels = options.enableDataChannels === undefined ? this.parent.config.enableDataChannels : options.enableDataChannels;
    this.receiveMedia = options.receiveMedia || this.parent.config.receiveMedia;
    // this streamConfig is for limiting bitrate via SDP modification,
    // which we are not currently using
    // we may want to use it in the future, however,
    // so i'm leaving it in place
    this.streamConfig = {
        videoRecvBitrate: options.videoBitrateLimit,
        audioRecvBitrate: options.audioBitrateLimit
    };
    this.channels = {};
    this.sid = options.sid || Date.now().toString();
    this.audioCodec = options.audioCodec || "";
    this.videoCodec = options.videoCodec || "";
    this.audioSDPBitrate = options.audioSDPBitrate || "";
    this.videoSDPBitrate = options.videoSDPBitrate || "";
    // Create an RTCPeerConnection via the polyfill
    this.pc = new PeerConnection(this.parent.config.peerConnectionConfig, this.parent.config.peerConnectionConstraints);
    this.pc.on('ice', this.onIceCandidate.bind(this));
    this.pc.on('endOfCandidates', function (event) {
        self.send('endOfCandidates', event);
    });
    this.pc.on('offer', function (offer) {
        if (self.parent.config.nick) offer.nick = self.parent.config.nick;
        // NOTE - this is to limit bitrate via SDP
        // we've disabled this for now, since we're using setParameters.
        // however we may want it in the future for broader device / browser support
        // offer.sdp = sdputils.maybeSetAudioReceiveBitRate(offer.sdp, self.streamConfig);
        // offer.sdp = sdputils.maybeSetVideoReceiveBitRate(offer.sdp, self.streamConfig);
        let sdp = offer.sdp;
        if (self.videoCodec) {
            sdp = preferCodec(sdp, 'video', self.videoCodec);
        }
        if (self.audioCodec) {
            sdp = preferCodec(sdp, 'audio', self.audioCodec);
        }

        if (self.videoSDPBitrate) {
            sdp = setBitrate(sdp, 'video', '1024');
        }
        if (self.audioSDPBitrate) {
            sdp = setBitrate(sdp, 'video', '1024');
        }
        offer.sdp = sdp;
        self.send('offer', offer);
    });
    this.pc.on('answer', function (answer) {
        if (self.parent.config.nick) answer.nick = self.parent.config.nick;
        // NOTE - this is to limit bitrate via SDP
        // answer.sdp = sdputils.maybeSetAudioReceiveBitRate(answer.sdp, self.streamConfig);
        // answer.sdp = sdputils.maybeSetVideoReceiveBitRate(answer.sdp, self.streamConfig);
        let sdp = answer.sdp;
        if (self.videoCodec) {
            sdp = preferCodec(sdp, 'video', self.videoCodec);
        }
        if (self.audioCodec) {
            sdp = preferCodec(sdp, 'audio', self.audioCodec);
        }

        if (self.videoSDPBitrate) {
            sdp = setBitrate(sdp, 'video', self.videoSDPBitrate);
        }
        if (self.audioSDPBitrate) {
            sdp = setBitrate(sdp, 'video', self.videoSDPBitrate);
        }

        answer.sdp = sdp;
        self.send('answer', answer);
    });
    this.pc.on('addStream', this.handleRemoteStreamAdded.bind(this));
    this.pc.on('addChannel', this.handleDataChannelAdded.bind(this));
    this.pc.on('removeStream', this.handleStreamRemoved.bind(this));
    // re-initiate offer/answer process when renegotiation is required
    this.pc.on('negotiationNeeded', function () {
        self.start();
    });
    this.pc.on('iceConnectionStateChange', this.emit.bind(this, 'iceConnectionStateChange'));
    this.pc.on('iceConnectionStateChange', function () {
        switch (self.pc.iceConnectionState) {
        case 'failed':
            // currently, in chrome only the initiator goes to failed
            // so we need to signal this to the peer
            if (self.pc.pc.localDescription.type === 'offer') {
                self.parent.emit('iceFailed', self);
                self.send('connectivityError');
            }
            break;
        }
    });
    this.pc.on('signalingStateChange', this.emit.bind(this, 'signalingStateChange'));
    this.logger = this.parent.logger;

    // handle screensharing/broadcast mode
    if (options.type === 'screen') {
        if (this.parent.localScreens && this.parent.localScreens[0] && this.sharemyscreen) {
            this.logger.log('adding local screen stream to peer connection');
            this.pc.addStream(this.parent.localScreens[0]);
            this.broadcaster = options.broadcaster;
        }
    } else {
        this.parent.localStreams.forEach(function (stream) {
            self.pc.addStream(stream);
        });
    }

    this.on('channelOpen', function (channel) {
        if (channel.protocol === INBAND_FILETRANSFER_V1) {
            channel.onmessage = function (event) {
                var metadata = JSON.parse(event.data);
                var receiver = new FileTransfer.Receiver();
                receiver.receive(metadata, channel);
                self.emit('fileTransfer', metadata, receiver);
                receiver.on('receivedFile', function (file, metadata) {
                    receiver.channel.close();
                });
            };
        }
    });

    // proxy events to parent
    this.on('*', function () {
        self.parent.emit.apply(self.parent, arguments);
    });
}

util.inherits(Peer, WildEmitter);

Peer.prototype.handleMessage = function (message) {
    var self = this;

    this.logger.log('getting', message.type, message);

    if (message.prefix) this.browserPrefix = message.prefix;

    if (message.type === 'offer') {
        if (!this.nick) this.nick = message.payload.nick;
        delete message.payload.nick;
        this.pc.handleOffer(message.payload, function (err) {
            if (err) {
                return;
            }
            // auto-accept
            self.pc.answer(function (err, sessionDescription) {
                //self.send('answer', sessionDescription);
            });
        });
    } else if (message.type === 'answer') {
        if (!this.nick) this.nick = message.payload.nick;
        delete message.payload.nick;
        this.pc.handleAnswer(message.payload);
    } else if (message.type === 'candidate') {
        this.pc.processIce(message.payload);
    } else if (message.type === 'connectivityError') {
        this.parent.emit('connectivityError', self);
    } else if (message.type === 'mute') {
        this.parent.emit('mute', {id: message.from, name: message.payload.name});
    } else if (message.type === 'unmute') {
        this.parent.emit('unmute', {id: message.from, name: message.payload.name});
    } else if (message.type === 'endOfCandidates') {
        this.pc.pc.addIceCandidate(undefined);
    }
};

// send via signalling channel
Peer.prototype.send = function (messageType, payload) {
    var message = {
        to: this.id,
        sid: this.sid,
        broadcaster: this.broadcaster,
        roomType: this.type,
        type: messageType,
        payload: payload,
        prefix: webrtcSupport.prefix
    };
    this.logger.log('sending', messageType, message);
    this.parent.emit('message', message);
};

// send via data channel
// returns true when message was sent and false if channel is not open
Peer.prototype.sendDirectly = function (channel, messageType, payload) {
    var message = {
        type: messageType,
        payload: payload
    };
    this.logger.log('sending via datachannel', channel, messageType, message);
    var dc = this.getDataChannel(channel);
    if (dc.readyState != 'open') return false;
    dc.send(JSON.stringify(message));
    return true;
};

// Internal method registering handlers for a data channel and emitting events on the peer
Peer.prototype._observeDataChannel = function (channel) {
    var self = this;
    channel.onclose = this.emit.bind(this, 'channelClose', channel);
    channel.onerror = this.emit.bind(this, 'channelError', channel);
    channel.onmessage = function (event) {
        self.emit('channelMessage', self, channel.label, JSON.parse(event.data), channel, event);
    };
    channel.onopen = this.emit.bind(this, 'channelOpen', channel);
};

// Fetch or create a data channel by the given name
Peer.prototype.getDataChannel = function (name, opts) {
    if (!webrtcSupport.supportDataChannel) return this.emit('error', new Error('createDataChannel not supported'));
    var channel = this.channels[name];
    opts || (opts = {});
    if (channel) return channel;
    // if we don't have one by this label, create it
    channel = this.channels[name] = this.pc.createDataChannel(name, opts);
    this._observeDataChannel(channel);
    return channel;
};

Peer.prototype.onIceCandidate = function (candidate) {
    if (this.closed) return;
    if (candidate) {
        var pcConfig = this.parent.config.peerConnectionConfig;
        if (webrtcSupport.prefix === 'moz' && pcConfig && pcConfig.iceTransports &&
                candidate.candidate && candidate.candidate.candidate &&
                candidate.candidate.candidate.indexOf(pcConfig.iceTransports) < 0) {
            this.logger.log('Ignoring ice candidate not matching pcConfig iceTransports type: ', pcConfig.iceTransports);
        } else {
            this.send('candidate', candidate);
        }
    } else {
        this.logger.log('End of candidates.');
    }
};

Peer.prototype.start = function () {
    var self = this;

    // well, the webrtc api requires that we either
    // a) create a datachannel a priori
    // b) do a renegotiation later to add the SCTP m-line
    // Let's do (a) first...
    if (this.enableDataChannels) {
        this.getDataChannel('simplewebrtc');
    }

    this.pc.offer(this.receiveMedia, function (err, sessionDescription) {
        //self.send('offer', sessionDescription);
    });
};

Peer.prototype.icerestart = function () {
    let constraints = this.receiveMedia;
    // ironically, mandatory may or may not be specified in the constraints
    constraints.mandatory = constraints.mandatory || {};
    constraints.mandatory.IceRestart = true;

    this.pc.offer(constraints, function (err, success) { });
};

Peer.prototype.setVideoBitrateLimit = function(bitrateLimit) {
    // NOTE - this only sets the *outgoing* bitrate limit
    // the incoming bitrate limit is determined by the peer
    // bitrateLimit is in kilobits per second (or the string 'unlimited')

    // don't limit bandwidth for screen sharing
    if (this.type === 'screen') {
        return;
    }

    // NOTE - this only works on chrome and (firefox >= 64)
    // use this.pc.pc to get the underlying RTCPeerConnection object
    // from the PeerConnection wrapper
    // this is kind of a hack
    var senders = this.pc.pc.getSenders();
    var sender;
    // the order of the returned array is random according to the spec,
    // so we have to determine which has the video track
    if (senders[0].track.kind === 'video') {
        sender = senders[0];
    } else {
        sender = senders[1];
    }

    var parameters = sender.getParameters();
    // parameters.encodings is sometimes undefined
    if (!parameters.encodings || !parameters.encodings[0]) {
        parameters.encodings = [{}];
    }

    if (bitrateLimit === 'unlimited') {
        delete parameters.encodings[0].maxBitrate;
    } else {
        // maxBitrate is measured in bits
        parameters.encodings[0].maxBitrate = bitrateLimit * 1000;
    }

    sender.setParameters(parameters).then(() => {
        this.logger.log(`set bitrate to ${bitrateLimit} succeeded`);
    }).catch(function (err) {
        this.logger.log(err);
    });
};

Peer.prototype.end = function () {
    if (this.closed) return;
    this.pc.close();
    this.handleStreamRemoved();
};

Peer.prototype.handleRemoteStreamAdded = function (event) {
    var self = this;
    if (this.stream) {
        this.logger.warn('Already have a remote stream');
    } else {
        this.stream = event.stream;

        this.stream.getTracks().forEach(function (track) {
            track.addEventListener('ended', function () {
                if (isAllTracksEnded(self.stream)) {
                    self.end();
                }
            });
        });

        this.parent.emit('peerStreamAdded', this);
    }
};

Peer.prototype.handleStreamRemoved = function () {
    var peerIndex = this.parent.peers.indexOf(this);
    if (peerIndex > -1) {
        this.parent.peers.splice(peerIndex, 1);
        this.closed = true;
        this.parent.emit('peerStreamRemoved', this);
    }
};

Peer.prototype.handleDataChannelAdded = function (channel) {
    this.channels[channel.label] = channel;
    this._observeDataChannel(channel);
};

Peer.prototype.sendFile = function (file) {
    var sender = new FileTransfer.Sender();
    var dc = this.getDataChannel('filetransfer' + (new Date()).getTime(), {
        protocol: INBAND_FILETRANSFER_V1
    });
    // override onopen
    dc.onopen = function () {
        dc.send(JSON.stringify({
            size: file.size,
            name: file.name
        }));
        sender.send(file, dc);
    };
    // override onclose
    dc.onclose = () => {
        this.logger.log('sender received transfer');
        sender.emit('complete');
    };
    return sender;
};

module.exports = Peer;
