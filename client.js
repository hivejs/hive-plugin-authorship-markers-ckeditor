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
  , AtomicEmitter = require('atomic-emitter')

const SET_COLOR = 'AUTHORSHIPMARKERSCKEDITOR_SET_COLOR'
const LOAD_USER = 'AUTHORSHIPMARKERSCKEDITOR_LOAD_USER'
const UPDATE_ATTRIBUTIONS = 'AUTHORSHIPMARKERSCKEDITOR_UPDATE_ATTRIBUTIONSR'

module.exports = setup
module.exports.consumes = ['ui', 'editor', 'api', 'presence']
module.exports.provides = ['authorshipMarkersCkeditor']
function setup(plugin, imports, register) {
  var ui = imports.ui
    , editor = imports.editor
    , api = imports.api
    , presence = imports.presence

  ui.reduxReducerMap.authorshipMarkersCkeditor = reducer
  function reducer(state, action) {
    if(!state) {
      return {
        authors: {}
      , attributions: {}
      }
    }
    if(LOAD_USER === action.type) {
      return {...state, authors: {
        ...state.authors
      , [action.payload.id]: action.payload
      }}
    }
    if(UPDATE_ATTRIBUTIONS === action.type) {
      return {...state, attributions: action.payload}
    }
    if(SET_COLOR === action.type) {
      return {...state, authors: {
        ...state.authors
      , [action.id]: {...state.authors[action.id], color: action.payload}
      }}
    }
    return state
  }

  ui.reduxRootReducers.push((state, action) => {
    if(SET_COLOR === action.type) {
      return {...state, session: {
        ...state.session
      , user: {...state.session.user, color: action.payload}
      }}
    }
    return state
  })

  var authorshipMarkers = {
    action_setColor: function*(color) {
      var state = ui.store.getState()
      yield api.action_user_update(state.session.user.id, {...state.session.user, color})
      yield {type: SET_COLOR, payload: color, id: state.session.user.id}
    }
  , action_loadUser: function*(userId) {
      var user = yield api.action_user_get(userId)
      return yield {type: LOAD_USER, payload: user}
    }
  , action_updateAttributions: function(attributions) {
      return {type: UPDATE_ATTRIBUTIONS, payload: attributions}
    }
  , attributionsChanged: AtomicEmitter()
  }


  editor.onLoad((editableDocument, broadcast) => {
    // This plugin works with the default html editor only
    if(ui.store.getState().editor.editor !== 'CKeditor') return

    ui.store.dispatch({type: LOAD_USER
    , payload: ui.store.getState().session.user})

    var editorRoot = editableDocument.rootNode


    // Setup the rendering environment

    var tree = render(ui.store)
      , rootNode = vdom.create(tree)

    ui.store.subscribe(_ => {
      var newtree = render(ui.store)
      var patches = vdom.diff(tree, newtree)
      vdom.patch(rootNode, patches)
      tree = newtree
    })

    var content = document.querySelector('.Editor__content')
    content.insertBefore(rootNode, content.firstChild)

    // If the main editor window is scrolled, scroll the markers, too
    editorRoot.addEventListener('scroll', function() {
      rootNode.scrollTop = editorRoot.scrollTop
    })

    setInterval(function() {
      var state = ui.store.getState().authorshipMarkersCkeditor
      Object.keys(state.authors)
      .map(function(authorId) {
        return ui.store.dispatch(authorshipMarkers.action_loadUser(authorId))
      })
    }, 10000)


    // Wire up attribution collection

    // on init
    editableDocument.on('init', authorshipMarkers.attributionsChanged.emit)

    // if this user makes changes
    editableDocument.on('update', function(edit) {
      setTimeout(function() {
        // ...attribute the changes to them
        edit.changeset.forEach(function(op) {
          var path
          if(op.path) path = op.path
          if(op.to) path = op.to
          if(!path) return
          var node = nodeAt(path, editableDocument.rootNode)
          if(op.to && !op.from) resetAuthorsOfNode(node)
          addAuthorToNode(node, ui.store.getState().session.user.id)
        })
        authorshipMarkers.attributionsChanged.emit()
      }, 0)
    })

    // if someone else makes changes...
    editableDocument.on('edit', authorshipMarkers.attributionsChanged.emit)

    authorshipMarkers.attributionsChanged(function() {
      var state = ui.store.getState().authorshipMarkersCkeditor

      // re-collect attributions
      var sectionsByAuthor = collectAttributions(editorRoot)

      // load any unknown author/user objects
      Promise.all(
        Object.keys(sectionsByAuthor)
        .map(function(authorId) {
          if(state.authors[authorId]) return Promise.resolve()
          return ui.store.dispatch(authorshipMarkers.action_loadUser(authorId))
        })
      ).then(function() {
        ui.store.dispatch(
          authorshipMarkers.action_updateAttributions(sectionsByAuthor)
        )
      })
    })


    presence.onRenderUser(function(store, user, props, children) {
      var state = store.getState()
      // Border color
      var style = props.style || (props.style = {})
        , color = user.color || '#777'
      style['border-color'] = color

      // Color picker if user === this user
      if(user.id == state.session.user.id) {
        var input = h('input.btn.btn-default',
        { attributes: {type: 'color', value: color}
        , 'ev-change': evt => {
            store.dispatch(authorshipMarkers.action_setColor(evt.currentTarget.value))
          }
        })
       children.push(input)
      }
    })
  })

  register(null, {authorshipMarkersCkeditor: authorshipMarkers})
}

function render(store) {
  var state = store.getState().authorshipMarkersCkeditor
  // Visualize authorship by drawing lines for each author
  return h('div.AuthorshipMarkers',
    Object.keys(state.attributions).map((author) => {
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
    })
  )
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
