/**
 * Synthetic action: read chat history, hand the conversation to a webhook,
 * and report failures to a notify endpoint.
 * @title Handover (synthetic)
 * @category Custom
 * @author example
 */
const axios = require('axios')

const historyMessage = async () => {
  try {
    const { data } = await axios.get(`https://history.example.test/api/session/history/${session.sid}`)
    return data.Data
  } catch (e) {
    bp.logger.error('history lookup failed', e)
    return event.payload.metadata.cust_message
  }
}

const handover = async () => {
  try {
    const histMessage = await historyMessage()
    const profile = event.payload.metadata.profile

    const payload = {
      sid: event.payload.metadata.sid,
      group_id: session.group_id,
      email: profile.email,
      name: profile.username,
      mobilePhone: profile.mobilePhone,
      account_id: event.payload.metadata.accountId,
      unique_id: event.payload.metadata.unique_id,
      message: `${histMessage}`,
      cust_message: JSON.stringify({ email: profile.email, name: profile.username, mobilePhone: profile.mobilePhone })
    }

    await axios.post('https://webhook.example.test/api/v2/incoming/handover', payload)

    const payloads = await bp.cms.renderElement('builtin_text', { text: 'Handover accepted' }, event)
    await bp.events.replyToEvent(event, payloads)
  } catch (e) {
    bp.logger.info('handover failed', e)
    await axios.post(
      'https://notify.example.test/sendMessage',
      { chat_id: 'example-chat', text: `Error handover: ${e}` },
      { headers: { 'Content-Type': 'application/json' } }
    )
  }
}

return handover()
