// Runs before a conversation ends (production hook shape: reads state, calls a webhook).
const axios = require('axios')

const run = async () => {
  event.state.temp.endHook = 'ran'
  await axios.post(event.state.session.mock + '/hook', { sid: event.state.session.sid })
}

return run()
