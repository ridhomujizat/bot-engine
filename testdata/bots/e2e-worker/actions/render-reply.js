/**
 * Renders a content type through the CMS and sends it as the reply.
 * @title Render and reply
 * @category E2E
 * @param {string} tag - label in the rendered text
 */

const run = async () => {
  const payloads = await bp.cms.renderElement(
    'builtin_single-choice',
    {
      text: 'Rendered ' + args.tag + ' for ' + session.sid,
      choices: [
        { title: 'Ya', value: 'ya' },
        { title: 'Tidak', value: 'tidak' }
      ]
    },
    event
  )
  await bp.events.replyToEvent(event, payloads)
  session.rendered = payloads.length
}

return run()
