/**
 * Synthetic action: signs a queue-position request with HMAC-SHA256.
 * @title Queue position (synthetic)
 * @category Custom
 * @author example
 */
const axios = require('axios')
const crypto = require('crypto')
const qs = require('qs')

const queuePosition = async () => {
  session.queuePosition = 1
  bp.logger.info('queue check', session.menu_channel)

  if (session.menu_channel === 'general_service') {
    const query = { channel_id: 12, conv_id: `${session.accountId}_${session.unique_id}` }
    if (session.group_id) {
      query.group_id = `${session.group_id}`
    }
    const url = `https://signed.example.test/api/service/interaction/queuePosition?${qs.stringify(query)}`

    const token = Buffer.from('example-user:example-pass').toString('base64')
    const dateNow = new Date().getTime()
    const signature = crypto
      .createHmac('sha256', 'example-secret-key')
      .update(`xmen:${dateNow}`)
      .digest('hex')

    const { data } = await axios.get(url, {
      headers: {
        Authorization: `Basic ${token}`,
        'x-tenant': 'example_tenant',
        'x-time': dateNow.toString(),
        'x-encrypt': signature
      }
    })

    session.queuePosition = data.listQueue
    bp.logger.info('queue url', url)
    bp.logger.info('queue position', session.queuePosition)
  }
}

return queuePosition()
