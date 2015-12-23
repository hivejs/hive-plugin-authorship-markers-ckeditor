/**
 * hive.js
 * Copyright (C) 2013-2015 Marcel Klehr <mklehr@gmx.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var vdom = require('virtual-dom')
  , h = vdom.h
  , nodeAt = require('dom-ot/lib/ops/node-at')
  , ObservEmitter = require('observ-emitter')
  , ObservStruct = require('observ-struct')
  , ObservVarhash = require('observ-varhash')
  , ObservValue = require('observ')
  , co = require('co')

module.exports = setup
module.exports.consumes = ['ui', 'editor', 'models', 'hooks']
function setup(plugin, imports, register) {
  var ui = imports.ui
  , models = imports.models
  , hooks = imports.hooks

  hooks.on('ui:initState', function* () {
    ui.state.events.put('authorshipMarkers:attributionsChanged', ObservEmitter())
    ui.state.events.put('authorshipMarkers:setColor', ObservEmitter())
  })

  ui.page('/documents/:id', function(ctx, next) {
    // This plugin works with the default html editor only
    if(ui.state.document.get('type') !== 'html') return next()

    // state
    ui.state.put('authorshipMarkers', ObservStruct({
      authors: ObservVarhash()
    , attributions: ObservValue({})
    }))

    var state = ui.state.authorshipMarkers
      , editorRoot

    ui.state.events['authorshipMarkers:setColor'].listen(function(evt) {
      ui.state.user.set('color', evt.currentTarget.value)
      ui.state.user.save()
    })

    ui.state.events['authorshipMarkers:attributionsChanged'].listen(function() {
      co(function*() {
        // re-collect attributions
        var sectionsByAuthor = collectAttributions(editorRoot)

        // load any unknown author/user objects
        yield Object.keys(sectionsByAuthor)
        .map(function*(authorId) {
          if(state.authors[authorId]) return
          if(authorId == ui.state.user.get('id')) {
            return state.authors.put(ui.state.user.get('id'), ui.state.user)
          }
          var author = new ctx.models.user({id: authorId})
          yield function(cb) {
            author.fetch({
              success: function(){cb()}
            , error: function(m, resp){cb(new Error('Server returned '+resp.status))}
            })
          }
          // stememberore author
          state.authors.put(author.get('id'), models.toObserv(author))
        })
        // update sections
        state.attributions.set(sectionsByAuthor)
      }).then(function() {}, function(er) {throw er})
    })

    ui.state.events['editor:load'].listen(function(editableDocument) {
      var tree = render(state())
        , rootNode = vdom.create(tree)

      editorRoot = editableDocument.rootNode

      var content = document.querySelector('.Editor__content')
      content.insertBefore(rootNode, content.firstChild)

      state(function(snapshot) {
        var newtree = render(snapshot)
        var patches = vdom.diff(tree, newtree)
        vdom.patch(rootNode, patches)
        tree = newtree
        rootNode.scrollTop = editorRoot.scrollY
      })

      // when the document has been initialized
      editableDocument.on('init', function() {
        ui.state.events['authorshipMarkers:attributionsChanged'].emit()
      })

      // If this user makes changes...
      editableDocument.on('update', function(edit) {
        setTimeout(function() {
          // ...attribute the changes to them
          edit.changeset.forEach(function(op) {
            var path
            if(op.path) path = op.path
            if(op.to) path = op.to
            if(!path) return
            var node = nodeAt(path, ctx.editableDocument.rootNode)
            if(op.to && !op.from) resetAuthorsOfNode(node)
            addAuthorToNode(node, ui.state.user.get('id'))
          })
          ui.state.events['authorshipMarkers:attributionsChanged'].emit()
        }, 0)
      })

      // If someone else makes changes...
      editableDocument.on('edit', function() {
        ui.state.events['authorshipMarkers:attributionsChanged'].emit()
      })

      // If the main editor window is scrolled, scroll the markers, too
      editorRoot.addEventListener('scroll', function() {
        rootNode.scrollTop = editorRoot.scrollTop
      })

    })

    ui.state.events['presence:renderUser'].listen(function(state, user, props, children) {
      // Border color
      var style = props.style || (props.style = {})
        , color = user.color || '#777'
      style['border-color'] = color

      // Color picker if user === this user
      if(user.id == state.user.id) {
        var input = h('input.btn.btn-default',
          {attributes: {type: 'color', value: color}
        , 'ev-change': state.events['authorshipMarkers:setColor']
        })
       children.push(input)
      }
    })

    next()
  })

  register()
}

function render(state) {
  // Visualize authorship by drawing lines for each author
  return h('div.AuthorshipMarkers', Object.keys(state.attributions).map(function(author) {
    return h('div.AuthorshipMarkers__Section'
    , state.attributions[author].map(function(section) {
        return h('div.AuthorshipMarkers__Marker', {
          style: {
            'border-color': state.authors[author].color || '#777'
          , 'height': section.height+'px'
          , 'top': section.y+'px'
          }
        , attributes: {
            title: state.authors[author].name
          }
        })
      })
    )
  }))
}

function collectAttributions(rootNode) {
  // Extract authorship sections from the document
  var sections = seekAuthors(rootNode)
  var sectionsByAuthor = sortByAuthors(sections)
  return sectionsByAuthor
}

function seekAuthors(root, el, data) {
  if(!data) data = []
  if(!el) el = root
  for(var i=0; i<el.children.length; i++) {
    var node = el.children[i]
      , authors = getAuthorsOfNode(node)
      , boundingRect = node.getBoundingClientRect()
    var obj = {
      y: boundingRect.top-root.getBoundingClientRect().top
    , height: boundingRect.height
    , authors: authors
    }
    data.push(obj)
    seekAuthors(root, node, data)
  }
  return data
}
function sortByAuthors(sections) {
  var sectionsByAuthor = {}
  sections.forEach(function(section) {
    Object.keys(section.authors).forEach(function(author) {
      if(!sectionsByAuthor[author]) sectionsByAuthor[author] = []
      sectionsByAuthor[author].push({y: section.y, height: section.height})
    })
  })
  return sectionsByAuthor
}

function addAuthorToNode(node, userId) {
  if(!(node instanceof Element)) node = node.parentNode
  var authors = getAuthorsOfNode(node)

  authors[userId] = true

  node.setAttribute('data-author', Object.keys(authors).join(' '))
}

function resetAuthorsOfNode(node) {
  if(node instanceof Element) {
    node.setAttribute('data-author', '')
  }
}

function getAuthorsOfNode(node) {
  var authorstring = node.getAttribute('data-author')
    , authors
  if(!authorstring) authors = {}
  else authors = parseAuthors(authorstring)

  return authors
}

function parseAuthors(authorString) {
  var authors = {}
  authorString
  .split(' ')
  .forEach(function(authorId) {
    authors[authorId] = true
  })

  return authors
}
