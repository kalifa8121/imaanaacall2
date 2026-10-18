const socket = io();
let currentUser = null, isSignup = false, currentStream = null, peer = null, incomingData = null;
const ringtone = document.getElementById('ringtone');

function toggleAuthMode() {
  isSignup = !isSignup;
  document.getElementById('auth-title').innerText = isSignup ? 'Signup' : 'Login';
  document.getElementById('auth-btn').innerText = isSignup ? 'Signup' : 'Login';
}

async function handleAuth() {
  const username = document.getElementById('auth-username').value;
  const password = document.getElementById('auth-password').value;
  const phone = document.getElementById('auth-phone').value;
  const bio = document.getElementById('auth-bio').value;

  const endpoint = isSignup ? '/api/auth/signup' : '/api/auth/login';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, phone, bio })
  });

  const data = await res.json();
  if(!data.success) return alert(data.message);

  currentUser = data.user;
  document.getElementById('auth-sec').style.display = 'none';
  document.getElementById('app-sec').style.display = 'block';

  document.getElementById('user-head-sec').innerHTML = `
    <b>@${currentUser.username}</b> 
    <button onclick="logout()" class="btn btn-danger" style="width:auto; padding:5px 10px;">Logout</button>`;

  socket.emit('register-user', currentUser.username);
  loadPosts();
}

function logout() {
  location.reload();
}

async function saveProfile() {
  const phone = document.getElementById('edit-phone').value;
  const bio = document.getElementById('edit-bio').value;

  await fetch('/api/profile/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: currentUser.username, phone, bio, avatar: '' })
  });
  alert("Profile Updated!");
}

socket.on('update-user-list', users => {
  const container = document.getElementById('users-list');
  container.innerHTML = '';

  users.filter(u => u.username !== currentUser.username).forEach(u => {
    container.innerHTML += `
      <div class="user-list-item">
        <div>
          <span class="status-dot ${u.isOnline ? 'online' : 'offline'}"></span>
          <b>@${u.username}</b>
        </div>
        <div>
          ${u.isOnline ? `
            <button class="btn btn-green" style="width:auto; padding:5px;" onclick="startCall('${u.username}', false)">Voice 📞</button>
            <button class="btn btn-primary" style="width:auto; padding:5px;" onclick="startCall('${u.username}', true)">Video 📹</button>
          ` : '<small>Offline</small>'}
        </div>
      </div>`;
  });
});

// WEBRTC CALL ENGINE LOGIC
async function startCall(userToCall, isVideo) {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo });
    document.getElementById('local-video').srcObject = currentStream;
    document.getElementById('call-screen').style.display = 'block';

    peer = new SimplePeer({ initiator: true, trickle: false, stream: currentStream });

    peer.on('signal', signalData => {
      socket.emit('call-user', { userToCall, signalData, callerName: currentUser.username, isVideo });
    });

    peer.on('stream', stream => {
      document.getElementById('remote-video').srcObject = stream;
    });
  } catch(e) { alert("Camera/Microphone Permission Gaafatamaa!"); }
}

socket.on('incoming-call', data => {
  incomingData = data;
  document.getElementById('caller-name-txt').innerText = `${data.callerName} is calling...`;
  document.getElementById('call-modal').style.display = 'flex';
  ringtone.play().catch(e => console.log(e));
});

async function acceptCall() {
  ringtone.pause();
  document.getElementById('call-modal').style.display = 'none';
  document.getElementById('call-screen').style.display = 'block';

  currentStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: incomingData.isVideo });
  document.getElementById('local-video').srcObject = currentStream;

  peer = new SimplePeer({ initiator: false, trickle: false, stream: currentStream });

  peer.on('signal', signal => socket.emit('accept-call', { signal, to: incomingData.from }));
  peer.on('stream', stream => {
    document.getElementById('remote-video').srcObject = stream;
  });

  peer.signal(incomingData.signal);
}

function rejectCall() {
  ringtone.pause();
  document.getElementById('call-modal').style.display = 'none';
  socket.emit('reject-call', { to: incomingData.from });
}

socket.on('call-accepted', signal => peer.signal(signal));
socket.on('call-failed-offline', () => { alert("Maammilli offline waan ta'eef bilbilamuu hin dandeenye."); endCall(); });

function endCall() {
  if (peer) peer.destroy();
  if (currentStream) currentStream.getTracks().forEach(t => t.stop());
  document.getElementById('call-screen').style.display = 'none';
}

function submitPost() {
  const content = document.getElementById('post-text').value;
  const file = document.getElementById('post-file').files[0];

  if (file) {
    const reader = new FileReader();
    reader.onload = e => {
      const type = file.type.startsWith('video') ? 'video' : 'image';
      socket.emit('create-post', { username: currentUser.username, content, mediaUrl: e.target.result, mediaType: type });
    };
    reader.readAsDataURL(file);
  } else {
    socket.emit('create-post', { username: currentUser.username, content });
  }
}

socket.on('post-submitted-silent', post => {
  document.getElementById('post-text').value = '';
  alert("Post Review f ka'ameera, battalatti ilaalama.");
});

async function loadPosts() {
  const res = await fetch('/api/posts');
  const posts = await res.json();
  const feed = document.getElementById('feed-container');
  feed.innerHTML = '';
  posts.forEach(p => {
    feed.innerHTML += `
      <div class="post">
        <b>@${p.username}</b>
        <p>${p.content || ''}</p>
        ${p.media_type === 'image' ? `<img src="${p.media_url}">` : ''}
        ${p.media_type === 'video' ? `<video src="${p.media_url}" controls></video>` : ''}
      </div>`;
  });
}
